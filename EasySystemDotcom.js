const { getBotConfig, getBotUrls } = require("./lib/config");

let ErrorHandler,
  CircuitBreaker,
  SessionManager,
  ApiClientWrapper,
  EnhancedLogger,
  HealthMonitor;

try {
  // Pull shared finalize-kit parts if they exist in this runtime
  ErrorHandler = require("./start/shared/error-handler");
  CircuitBreaker = require("./start/shared/circuit-breaker");
  SessionManager = require("./start/shared/session-manager");
  EnhancedLogger = require("./start/shared/enhanced-logger");

  const HMMod = require("./start/shared/health-monitor");
  const RAIMod = require("./start/shared/resilient-api-client");

  // Support both default/named exports — because… modules
  HealthMonitor = (HMMod && (HMMod.HealthMonitor || HMMod.default)) || HMMod;
  if (typeof HealthMonitor !== "function") {
    throw new TypeError(
      `HealthMonitor export mismatch; keys: ${HMMod && Object.keys(HMMod)}`
    );
  }

  ApiClientWrapper =
    (RAIMod && (RAIMod.ApiClientWrapper || RAIMod.default)) || RAIMod;
  if (typeof ApiClientWrapper !== "function") {
    throw new TypeError(
      `ApiClientWrapper export mismatch; keys: ${RAIMod && Object.keys(RAIMod)}`
    );
  }
} catch (error) {
  // No shared kit? No problem — keep the lights on with minimal fallbacks.
  console.warn("⚠️  Shared components not found, using fallback implementations");
  console.warn("⚠️  Error:", error.message);

  ErrorHandler = { handleError: (err, context, callback) => callback(err) };

  CircuitBreaker = {
    canExecute: () => true,
    recordSuccess: () => {},
    recordFailure: () => {},
  };

  SessionManager = { cleanup: () => {} };

  const crypto = require("crypto");
  EnhancedLogger = {
    generateCorrelationId: () =>
      crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString("hex"),
    logApiCallStart: () => {},
    logApiCallComplete: () => {},
    logApiCallError: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  };

  HealthMonitor = {
    start: () => {},
    stop: () => {},
    getHealthStatus: () => ({ status: "ok" }),
  };
}
// ---- Identity + env --------------------------------------------------------------------------
const botName = "EasySystemDotcom";
const botConfig = getBotConfig(botName); 
const botUrls = getBotUrls(botName);

console.log("🔍 DEBUG: botName:", botName);
console.log("🔍 DEBUG: botConfig:", JSON.stringify(botConfig, null, 2));
console.log("🔍 DEBUG: botConfig.botIds:", botConfig.botIds);

const sdk = require("./lib/sdk");
const PromiseLike = sdk.Promise; // parity with old code
const { makeHttpCall } = require("./makeHttpCall"); // kept if referenced elsewhere
const axios = require("axios");
const logger = require("./lib/logger");

const enhancedLogger = EnhancedLogger;
const errorHandler = ErrorHandler;
const circuitBreaker = CircuitBreaker;
const sessionManager = SessionManager;

const healthMonitor = new HealthMonitor({
  instanceId: "es-dotcom-bot",
  cleanupInterval: 30 * 60 * 1000, // sweep every 30 mins
});

// EasySystem endpoints (from env)
const easysytemUrl = botUrls.sendMessage;
const easysytemSaveMessageUrl = botUrls.saveMessage;
const contextUrl = botUrls.contextLoad;

// ---- HTTP client (resilient if possible) -----------------------------------------------------

let apiClient;
try {
  apiClient = new ApiClientWrapper({
    timeout: 30000,
    maxRetries: 3,
    baseDelay: 1000,
    maxDelay: 10000,
  });
  console.log("✅ ApiClientWrapper initialized successfully");
} catch (error) {
  // If resilient client is missing, axios will do just fine.
  console.warn("⚠️  ApiClientWrapper failed, using axios fallback");
  console.warn("⚠️  Error:", error.message);

  apiClient = {
    post: async (url, data, options = {}) => {
      const response = await axios.post(url, data, {
        timeout: options.timeout || 30000,
        headers: options.headers || { "Content-Type": "application/json" },
      });
      return response;
    },
    get: async (url, options = {}) => {
      const response = await axios.get(url, {
        timeout: options.timeout || 30000,
        headers: options.headers || { "Content-Type": "application/json" },
      });
      return response;
    },
  };
  console.log("✅ Axios fallback initialized successfully");
}

// ---- Transfer helper -------------------------------------------------------------------------

function triggerAgentTransfer(data, callback, messageIfAny) {
  try {
    if (messageIfAny) data.message = messageIfAny;
    data.agent_transfer = true;

    if (data.context?.session?.BotUserSession) {
      data.context.session.BotUserSession.transfer = true;
    }
    if (data.context?.session?.UserSession) {
      data.context.session.UserSession.owner = "kore";
    }
    return sdk.sendBotMessage(data, callback);
  } catch {
    // Even if we blow up above, still try to send *something*
    return sdk.sendBotMessage(data, callback);
  }
}

// ---- Circuit-breaker + logging wrappers ------------------------------------------------------

async function safeEasySystemCall(
  serviceName,
  url,
  requestData,
  data,
  callback,
  correlationId,
  originalCallback
) {
  try {
    const canExec = await Promise.resolve(circuitBreaker.canExecute(serviceName));
    if (!canExec) {
      enhancedLogger.warn(
        "CIRCUIT_BREAKER_OPEN",
        {
          service: serviceName,
          conversationId: data.context?.session?.BotUserSession?.conversationSessionId,
        },
        correlationId
      );
      return triggerAgentTransfer(data, callback, "Please hold while I transfer you to an agent.");
    }

    enhancedLogger.logApiCallStart(url, requestData, correlationId);

    const response = await apiClient.post(url, requestData, {
      headers: {
        "Content-Type": "application/json",
        "business-unit": data.context.session.BotUserSession.businessUnit,
      },
      timeout: 30000,
      data, // optional: some middlewares read this
    });

    await Promise.resolve(circuitBreaker.recordSuccess(serviceName, data));
    enhancedLogger.logApiCallComplete(url, response, correlationId);

    if (response?.data?.transfer === true || data.agent_transfer === true) {
      return triggerAgentTransfer(data, callback, response?.data?.text);
    }

    return originalCallback(response, data, callback);
  } catch (error) {
    await Promise.resolve(circuitBreaker.recordFailure(serviceName, data, error));
    enhancedLogger.logApiCallError(url, error, correlationId);

    return triggerAgentTransfer(data, callback, "Please hold while I transfer you to an agent.");
  }
}

async function safeMessageSave(
  url,
  messageSaveData,
  data,
  correlationId,
  successCallback,
  errorCallback
) {
  const cid = correlationId ?? enhancedLogger.generateCorrelationId();

  try {
    const canExec = await Promise.resolve(
      circuitBreaker.canExecute("easysystem-save-api", data)
    );
    if (!canExec) {
      enhancedLogger.warn(
        "CIRCUIT_BREAKER_OPEN",
        {
          service: "easysystem-save-api",
          conversationId: data?.context?.session?.BotUserSession?.conversationSessionId,
        },
        cid
      );
      if (typeof errorCallback === "function") errorCallback();
    }

    await apiClient.post(url, messageSaveData, {
      headers: {
        "Content-Type": "application/json",
        "X-Correlation-Id": cid,
        // "business-unit": data.context.session.BotUserSession.businessUnit, // enable if backend honors this
      },
      timeout: 30000,
      data,
    });

    await Promise.resolve(circuitBreaker.recordSuccess("easysystem-save-api"));

    enhancedLogger.info(
      "MESSAGE_SAVED_TO_EASYSYSTEM",
      { conversationId: messageSaveData?.externalConversationId },
      cid
    );

    if (typeof successCallback === "function") successCallback();
  } catch (saveError) {
    try {
      await Promise.resolve(circuitBreaker.recordFailure("easysystem-save-api", saveError));
    } catch {
      /* shrug */
    }

    enhancedLogger.warn(
      "MESSAGE_SAVE_FAILED",
      {
        error: saveError?.message,
        conversationId: messageSaveData?.externalConversationId,
      },
      cid
    );

    if (errorCallback) errorCallback(saveError);
  }
}

function handleAgentTransfer({ response, data, callback, sdk }) {
  try {
    if (response?.data?.transfer) {
      data.context.session.BotUserSession.transfer = response.data.transfer;
      console.log("Transfer to agent new = " + data.context.session.BotUserSession.transfer);
      console.log("setting owner as kore");
      data.context.session.UserSession.owner = 'kore';
      data.agent_transfer = true;
      sdk.sendBotMessage(data, callback);
      return true; // caller can early-return to avoid double-sends
    }
  } catch (e) {
    console.error("handleAgentTransfer error:", e?.message || e);
  }
  return false;
}

// ---- Inactivity bits (kept around for compatibility) -----------------------------------------

const INACTIVITY_TIMEOUT = 2 * 60 * 1000; // 2 minutes
const inactivityTimers = new Map();
const convoState = new Map();

function getUserId(data) {
  return (
    data?.context?.session?.BotUserSession?.channels?.[0]?.handle?.userId || null
  );
}
// ---- Lifecycle -------------------------------------------------------------------------------
healthMonitor.start();
// ---- Module Exports --------------------------------------------------------------------------
module.exports = {
  botId: botConfig.botIds,
  botName: botName,

  // Channel/client events (typing, etc.) — nothing fancy here
  on_client_event: function (requestId, data, callback) {
    return callback(null, data);
  },

  // User → bot messages
  on_user_message: function (requestId, data, callback) {
    const correlationId = enhancedLogger.generateCorrelationId();

    try {
      const session_owner = data.context.session.UserSession.owner;

      // Guardrails — if we don't have the basics, don't try to be clever.
      if (
        !data.context.session.BotUserSession.businessUnit ||
        data.context.session.BotUserSession.businessUnit === null ||
        data.context.session.BotUserSession.businessUnit === undefined
      ) {
        console.log("businessUnit is null or empty, not saving the message");
        return sdk.sendBotMessage(data, callback);
      }

      if (!data.message || data.message === null || data.message.trim() === "") {
        console.log("message is null or empty, not saving the message");
        return sdk.sendBotMessage(data, callback);
      }

      console.log(
        "businessUnit: " + data.context.session.BotUserSession.businessUnit
      );

      if (session_owner === "easysystem") {
        // ES drives the turn; we relay the message and return ES' reply
        const requestData = {
          text: data.message,
          conversationId:
            data.context.session.BotUserSession.conversationSessionId,
          businessUnit: data.context.session.BotUserSession.businessUnit,
        };

        // Save user message to ES transcript (fire-and-forget semantics)
        const messageSaveData = {
          text: data.message,
          externalConversationId:
            data.context.session.BotUserSession.conversationSessionId,
          businessUnit: data.context.session.BotUserSession.businessUnit,
          role: "user",
          channel: "Kore",
        };

        console.log("Saving message to Easy System", data.message);

        safeMessageSave(
          easysytemSaveMessageUrl,
          messageSaveData,
          data,
          correlationId,
          () => {
            console.log(
              "✅ Message saved successfully for conversationId:",
              messageSaveData.externalConversationId
            );
          },
          (err) => {
            console.error("❌ Message save failed:", err?.message || err);
          }
        );

        // Round-trip to ES, echo result back to the user
        safeEasySystemCall(
          "easysystem-send-api",
          easysytemUrl,
          requestData,
          data,
          callback,
          correlationId,
          (response, data, callback) => {
            logger.info("Easysystem response:", JSON.stringify(response.data));
            data.message = response.data.text;

            logger.info("is conversation end = " + response.data.endConversation);
            logger.info("Transfer to agent = " + response.data.transfer);

            if (response.data.transfer) {
              data.context.session.BotUserSession.transfer = response.data.transfer;
              logger.info(
                "Transfer to agent new = " +
                  data.context.session.BotUserSession.transfer
              );
              logger.info("setting owner as kore");
              data.context.session.UserSession.owner = "kore";
              data.agent_transfer = true;
              return sdk.sendBotMessage(data, callback);
            } else if (response.data.endConversation) {
              // Note: preserve original flag naming
              data.context.session.BotUserSession.endConversationFromEasySystema =
                response.data.endConversation;
              logger.info(
                "is conversation end new = " +
                  data.context.session.BotUserSession.endConversationFromEasySystem
              );
              logger.info("setting owner as kore");
              data.context.session.UserSession.owner = "kore";
            }

            return sdk.sendUserMessage(data, callback);
          }
        )
          .then(() => {
            console.log("✅ safeEasySystemCall completed successfully.");
          })
          .catch((err) => {
            console.error("❌ safeEasySystemCall failed:", err?.message || err);
            triggerAgentTransfer(
              data,
              callback, "Please hold while I transfer you to an agent."
            );
          });
      } else {
        // KORE owns the turn — save what the user said, let dialog do its thing
        if (data.message !== null) {
          const messageSaveData = {
            text: data.message,
            externalConversationId:
              data.context.session.BotUserSession.conversationSessionId,
            businessUnit: data.context.session.BotUserSession.businessUnit,
            role: "user",
            channel: "Kore",
          };

          safeMessageSave(
            easysytemSaveMessageUrl,
            messageSaveData,
            data,
            correlationId,
            () => {
              console.log(
                "on_user_message:: easysystem message saved for conversationId " +
                  messageSaveData.externalConversationId
              );
            },
            (error) => {
              console.error(
                "Error updating easysystem context:",
                error?.response ? error.response.data : error?.message
              );
            }
          );
        }
        return sdk.sendBotMessage(data, callback);
      }
    } catch (error) {
      enhancedLogger.error(
        "USER_MESSAGE_PROCESSING_ERROR",
        {
          error: error.message,
          conversationId:
            data.context?.session?.BotUserSession?.conversationSessionId,
        },
        correlationId
      );

      return triggerAgentTransfer(
        data,
        callback, "Please hold while I transfer you to an agent."
      );
    }
  },

  // Bot → user messages (save assistant outputs when KORE owns)
  on_bot_message: function (requestId, data, callback) {
    const correlationId = enhancedLogger.generateCorrelationId();

    try {
      const session_owner = data.context.session.UserSession.owner;

      if (
        !data.context.session.BotUserSession.businessUnit ||
        data.context.session.BotUserSession.businessUnit === null ||
        data.context.session.BotUserSession.businessUnit === undefined
      ) {
        console.log("businessUnit is null or empty, not saving the message");
        return sdk.sendUserMessage(data, callback);
      }

      if (!data.message || data.message === null || data.message.trim() === "") {
        console.log("message is null or empty,  not saving the message");
        return sdk.sendUserMessage(data, callback);
      }

      console.log(
        "on_bot_message conversationSessionId [] message:" + data.message
      );
      console.log(
        "businessUnit: " + data.context.session.BotUserSession.businessUnit
      );

      const messageSaveData = {
        text: data.message,
        externalConversationId:
          data.context.session.BotUserSession.conversationSessionId,
        businessUnit: data.context.session.BotUserSession.businessUnit,
        role: "assistant",
        channel: "Kore",
      };

      if (session_owner === "easysystem") {
        console.log("on_bot_message blocked by easyssytem owner check");
      } else {
        console.log("on_bot_message owner KORE");

        safeMessageSave(
          easysytemSaveMessageUrl,
          messageSaveData,
          data,
          correlationId,
          () => {
            console.log(
              "on_user_message:: easysystem message saved for conversationId " +
                messageSaveData.externalConversationId
            );
          },
          (error) => {
            console.error(
              "Error updating easysystem context:",
              error?.response ? error.response.data : error?.message
            );
          }
        );

        return sdk.sendUserMessage(data, callback);
      }
    } catch (error) {
      enhancedLogger.error(
        "BOT_MESSAGE_PROCESSING_ERROR",
        {
          error: error.message,
          conversationId:
            data.context?.session?.BotUserSession?.conversationSessionId,
        },
        correlationId
      );

      return triggerAgentTransfer(
        data,
        callback, "Please hold while I transfer you to an agent."
      );
    }
  },

  // Webhooks from dialog nodes/routes - Updated with SBA structure
  on_webhook: function (requestId, data, componentName, callback) {
    const correlationId = enhancedLogger.generateCorrelationId();

    try {
      console.log("component name: " + componentName);

      const contextData = {
        externalConversationId:
          data.context.session.BotUserSession.conversationSessionId,
        conversationId:
          data.context.session.BotUserSession.conversationSessionId,
        assistantType: "STANDARD",
        channel: "Kore",
      };

      // We only route ES context updates for DOTCOM (business unit "C")
      if (data.context.session.BotUserSession.businessUnit !== "C") {
        return sdk.sendWebhookResponse(data, callback);
      }

      // SBA-style webhook mapping
      const webhookMap = {
        easySystemHook: "package_tracking_handover",
        CancelItemHook: "Cancel_item",
        CancelEntireHook: "Cancel_Entire_order",
        RefundHook: "Refund_Check",
        ReturnStatusHook: "Check_Return",
        ExchangeHook: "Exchange_Item",
        ShippingHook: "change_shipping_address",
        ExistingHook: "manage_existing_users",
        NewHook: "add_new_user_handler",
        easyInvoiceHook: "invoice_or_packing_slip",
        ModifyHook: "modify_shipping_location",
        ResetHook: "reset_password_handler",
        AccountHook: "account_id_handler",
        MissingHook: "missing_item"
      };

      const integName = webhookMap[componentName];

      // Helper to ACK once (only for SCRIPT_MODE)
      const ack = (d = data) => {
        d.status = "success";
        if (typeof sdk.sendWebhookResponse === "function") {
          return sdk.sendWebhookResponse(d, callback);
        }
        return callback(null, d);
      };

      if (!integName || !integrations[integName]) {
        console.warn("[WEBHOOK] No integration mapped for:", componentName);
        // ACK empty to keep dialog moving
        return ack();
      }

      const isScriptMode = SCRIPT_MODE.has(integName);

      // SCRIPT MODE: stash + ACK once; Script node will render next
      if (isScriptMode) {
        data._via_webhook = true; // informational
        updateESContextThen(contextUrl, contextData, data, callback, () => {
          console.log(
            "Context updated for conversationId " + contextData.externalConversationId
          );
          return integrations[integName](data, callback);
        }, correlationId);
        return;
      }

      // DIRECT-SEND MODE: send chat immediately, no ACK here
      // Do NOT set _via_webhook; we WANT messaging to go out directly
      updateESContextThen(contextUrl, contextData, data, callback, () => {
        console.log(
          "Context updated for conversationId " + contextData.externalConversationId
        );
        return integrations[integName](data, callback);
      }, correlationId);
    } catch (error) {
      enhancedLogger.error(
        "WEBHOOK_PROCESSING_ERROR",
        {
          error: error.message,
          componentName: componentName,
          conversationId:
            data.context?.session?.BotUserSession?.conversationSessionId,
        },
        correlationId
      );

      return triggerAgentTransfer(
        data,
        callback, "Please hold while I transfer you to an agent."
      );
    }
  },

  // Misc platform events (transfer, agent connected, end-of-session flags)
  on_event: function (requestId, data, callback) {
    const correlationId = enhancedLogger.generateCorrelationId();

    try {
      if (data?.context?.currentNodeType === "agentTransfer") {
        const userId = getUserId(data);
        console.log("Agent transfer initiated for user:", userId);
      }

      if (data?.context?.CCAIMetaInfo?.agentId) {
        const userId = getUserId(data);
        console.log("Agent connected for user:", userId);
      }

      if (
        data?.context?.session?.BotUserSession?.endConversationFromEasySystema &&
        data?.context?.session?.UserSession?.owner === "kore"
      ) {
        const userId = getUserId(data);
        console.log("Agent session ended; awaiting next user message for user:", userId);
      }

      return callback(null, data);
    } catch (error) {
      enhancedLogger.error(
        "EVENT_PROCESSING_ERROR",
        {
          error: error.message,
          conversationId:
            data?.context?.session?.BotUserSession?.conversationSessionId,
        },
        correlationId
      );
      return callback(null, data);
    }
  },

  getHealthStatus: async function () {
    return await healthMonitor.getHealthStatus();
  },

  cleanup: function () {
    sessionManager.cleanup();
    healthMonitor.stop();
    enhancedLogger.info("ES-Dotcom Bot cleanup completed");
  },
};

// ---- Webhook context helper (DRY for all routes) ---------------------------------------------

function updateESContextThen(contextUrl, contextData, data, callback, onSuccess, correlationId) {
  return safeEasySystemCall(
    "easysystem-context-api",
    contextUrl,
    contextData,
    data,
    callback,
    correlationId,
    () => onSuccess()
  );
}

// ---- SCRIPT_MODE definitions (from SBA) ----
const SCRIPT_MODE = new Set([
  "package_tracking_handover",
  "Check_Return",
]);

// ---- Integrations (SBA-style with Dotcom functionality) -------------------------------------------

function makeRequestData(data, text) {
  const convId = data.context.session.BotUserSession.conversationSessionId;
  const businessUnit = data.context.session.BotUserSession.businessUnit;

  return {
    text,
    externalConversationId: convId,
    conversationId: convId,
    businessUnit,
  };
}


// Helper functions for SBA-style integrations
function handleEasySendOutcome_Direct(tag, data, responseData, callback) {
  console.log(`${tag} Response:`, responseData);
  console.log("is conversation end =", responseData.endConversation);
  console.log("Transfer to agent =", responseData.transfer);

  // Always show what EasySystem sent
  data.message = responseData?.text || "";

  // First-reply transfer immediately
  if (responseData.transfer) {
    data.context.session.BotUserSession.transfer = true;
    data.agent_transfer = true;
    data.context.session.UserSession.owner = "kore";
    console.log(`[${tag}] First message is agent transfer — escalating.`);
    return sdk.sendBotMessage(data, callback);
  }

  // End conversation
  if (responseData.endConversation) {
    data.context.session.BotUserSession.endConversationFromEasySystem = true;
    data.context.session.UserSession.owner = "kore";
  }

  // Default: send to user
  processEasySystemResponse(data, responseData);
  return sdk.sendUserMessage(data, callback);
}

function handleEasySendError_Direct(tag, data, error, callback) {
  const status = error?.response?.status;
  const resp = error?.response?.data;
  console.error(`${tag} Error:`, status, resp || error.message);
  data.message = "Please hold while I transfer you to an agent.";
  data.agent_transfer = true;
  data.context.session.BotUserSession.transfer = true;
  data.context.session.UserSession.owner = "kore";
  return sdk.sendUserMessage(data, callback);
}

function processEasySystemResponse(data, responseData) {
  data.message = responseData.text;

  if (!responseData.transfer && !responseData.endConversation) {
    data.context.session.UserSession.owner = "easysystem";
  }
  if (responseData.transfer) {
    data.agent_transfer = true;
    data.context.session.BotUserSession.transfer = true;
    data.context.session.UserSession.owner = "kore";
  }
  if (responseData.endConversation) {
    data.context.session.BotUserSession.endConversationFromEasySystem = responseData.endConversation;
    data.context.session.UserSession.owner = "kore";
  }
}

const integrations = {
  // === SCRIPT MODE (stash ES response as-is; Script node will print) ===

  package_tracking_handover: function (data, callback) {
    const correlationId = enhancedLogger.generateCorrelationId();
    const orderNumber = data.context.orderNumber;
    const zipCode = data.context.zipCode;

    const requestData = {
      text: `can you help me track my order? My order number is ${orderNumber} and zip code is ${zipCode}`,
      externalConversationId: data.context.session.BotUserSession.conversationSessionId,
      conversationId: data.context.session.BotUserSession.conversationSessionId,
      businessUnit: data.context.session.BotUserSession.businessUnit,
    };

    safeEasySystemCall(
      "easysystem-send-api",
      easysytemUrl,
      requestData,
      data,
      callback,
      correlationId,
      (response, data, callback) => {
        console.log("Easysystem response:", JSON.stringify(response.data));
        
        // Stash EXACT result; Script node prints
        data.context.session.BotUserSession.render = response.data.contentType || "text/plain";
        data.context.session.BotUserSession.renderr = response.data.text || "";

        // First-reply transfer / end flags (no message send here)
        if (response.data.transfer) {
          data.context.session.BotUserSession.transfer = true;
          data.agent_transfer = true;
          data.context.session.UserSession.owner = "kore";
        }
        if (response.data.endConversation) {
          data.context.session.BotUserSession.endConversationFromEasySystem = true;
          data.context.session.UserSession.owner = "kore";
        }

        // Ensure next node runs (Script)
        data.context.session.UserSession.owner = "kore";

        return callback(null, data); // on_webhook ACKs
      }
    )
    .catch((error) => {
      console.error("package_tracking_handover error:", error?.message || error);

      // Safe fallback so Script node still shows something
      data.context.session.BotUserSession.render = "text/plain";
      data.context.session.BotUserSession.renderr = "Sorry, I couldn't fetch your tracking details right now.";
      data.context.session.UserSession.owner = "kore";
      return callback(null, data);
    });
  },

  Check_Return: function (data, callback) {
    const correlationId = enhancedLogger.generateCorrelationId();
    const orderNumber = data.context.orderNumber;
    const zipCode = data.context.zipCode;

    const requestData = {
      text: `Check the status for Return an order with order number ${orderNumber} and ZipCode ${zipCode}`,
      externalConversationId: data.context.session.BotUserSession.conversationSessionId,
      conversationId: data.context.session.BotUserSession.conversationSessionId,
      businessUnit: data.context.session.BotUserSession.businessUnit,
    };

    safeEasySystemCall(
      "easysystem-send-api",
      easysytemUrl,
      requestData,
      data,
      callback,
      correlationId,
      (response, data, callback) => {
        console.log("Easysystem response:", JSON.stringify(response.data));
        
        // Stash EXACT result; Script node prints
        data.context.session.BotUserSession.render = response.data.contentType || "text/plain";
        data.context.session.BotUserSession.renderr = response.data.text || "";

        // First-reply transfer / end flags (no message send here)
        if (response.data.transfer) {
          data.context.session.BotUserSession.transfer = true;
          data.agent_transfer = true;
          data.context.session.UserSession.owner = "kore";
        }
        if (response.data.endConversation) {
          data.context.session.BotUserSession.endConversationFromEasySystem = true;
          data.context.session.UserSession.owner = "kore";
        }

        // Ensure next node runs (Script)
        data.context.session.UserSession.owner = "kore";

        return callback(null, data); // on_webhook ACKs
      }
    )
    .catch((error) => {
      console.error("Return Status Error:", error?.message || error);

      // Safe fallback
      data.context.session.BotUserSession.render = "text/plain";
      data.context.session.BotUserSession.renderr = "Sorry, I couldn't fetch your return status.";
      data.context.session.UserSession.owner = "kore";
      return callback(null, data);
    });
  },

  // === DIRECT-SEND MODE (send ES reply immediately, honor first-reply transfer) ===

  Cancel_item: function (data, callback) {
    const orderNumber = data.context.orderNumberForCancelItem;
    const zipCode = data.context.zipcodeForCancelItem;
    const text = `Cancel Item having Order Number ${orderNumber} and ZipCode ${zipCode}`;
    
    const correlationId = enhancedLogger.generateCorrelationId();
    const requestData = makeRequestData(data, text);

    safeEasySystemCall(
      "easysystem-send-api",
      easysytemUrl,
      requestData,
      data,
      callback,
      correlationId,
      (response, data, callback) => {
        console.log("Easysystem response:", JSON.stringify(response.data));
        data.message = response.data.text;
        handleAgentTransfer({ response, data, callback, sdk });
        return sdk.sendUserMessage(data, callback);
      }
    ).catch((err) => {
      console.error("❌ safeEasySystemCall failed:", err?.message || err);
      return triggerAgentTransfer(
        data,
        callback, "Please hold while I transfer you to an agent."
      );
    });
  },

  add_new_user_handler: function (data, callback) {
    const text = "I want to add a new user to my Staples account.";
    const correlationId = enhancedLogger.generateCorrelationId();
    const requestData = makeRequestData(data, text);

    safeEasySystemCall(
      "easysystem-send-api",
      easysytemUrl,
      requestData,
      data,
      callback,
      correlationId,
      (response, data, callback) => {
        console.log("Easysystem response:", JSON.stringify(response.data));
        data.message = response.data.text;
        handleAgentTransfer({ response, data, callback, sdk });
        return sdk.sendUserMessage(data, callback);
      }
    ).catch((err) => {
      console.error("❌ safeEasySystemCall failed:", err?.message || err);
      return triggerAgentTransfer(
        data,
        callback, "Please hold while I transfer you to an agent."
      );
    });
  },

  Cancel_Entire_order: function (data, callback) {
    const orderNumber = data.context.orderNumberForCancelOrder;
    const zipCode = data.context.zipcodeForCancelOrder;
    const text = `Cancel the Entire Order having Order Number ${orderNumber} and ZipCode ${zipCode}`;
    const correlationId = enhancedLogger.generateCorrelationId();
    const requestData = makeRequestData(data, text);

    safeEasySystemCall(
      "easysystem-send-api",
      easysytemUrl,
      requestData,
      data,
      callback,
      correlationId,
      (response, data, callback) => {
        console.log("Easysystem response:", JSON.stringify(response.data));
        data.message = response.data.text;
        handleAgentTransfer({ response, data, callback, sdk });
        return sdk.sendUserMessage(data, callback);
      }
    ).catch((err) => {
      console.error("❌ safeEasySystemCall failed:", err?.message || err);
      return triggerAgentTransfer(
        data,
        callback, "Please hold while I transfer you to an agent."
      );
    });
  },

  Refund_Check: function (data, callback) {
    const text = "I want to check my refund status.";
    const correlationId = enhancedLogger.generateCorrelationId();
    const requestData = makeRequestData(data, text);

    safeEasySystemCall(
      "easysystem-send-api",
      easysytemUrl,
      requestData,
      data,
      callback,
      correlationId,
      (response, data, callback) => {
        console.log("Easysystem response:", JSON.stringify(response.data));
        data.message = response.data.text;
        handleAgentTransfer({ response, data, callback, sdk });
        return sdk.sendUserMessage(data, callback);
      }
    ).catch((err) => {
      console.error("❌ safeEasySystemCall failed:", err?.message || err);
      return triggerAgentTransfer(
        data,
        callback, "Please hold while I transfer you to an agent."
      );
    });
  },

  Exchange_Item: function (data, callback) {
    const text = "I want to return or exchange an item.";
    const correlationId = enhancedLogger.generateCorrelationId();
    const requestData = makeRequestData(data, text);

    safeEasySystemCall(
      "easysystem-send-api",
      easysytemUrl,
      requestData,
      data,
      callback,
      correlationId,
      (response, data, callback) => {
        console.log("Easysystem response:", JSON.stringify(response.data));
        data.message = response.data.text;
        handleAgentTransfer({ response, data, callback, sdk });
        return sdk.sendUserMessage(data, callback);
      }
    ).catch((err) => {
      console.error("❌ safeEasySystemCall failed:", err?.message || err);
      return triggerAgentTransfer(
        data,
        callback, "Please hold while I transfer you to an agent."
      );
    });
  },

  change_shipping_address: function (data, callback) {
    const text = "I want to add a new shipping location to my Staples account (enter address, set delivery preferences, and update contact details).";
    const correlationId = enhancedLogger.generateCorrelationId();
    const requestData = makeRequestData(data, text);

    safeEasySystemCall(
      "easysystem-send-api",
      easysytemUrl,
      requestData,
      data,
      callback,
      correlationId,
      (response, data, callback) => {
        console.log("Easysystem response:", JSON.stringify(response.data));
        data.message = response.data.text;
        handleAgentTransfer({ response, data, callback, sdk });
        return sdk.sendUserMessage(data, callback);
      }
    ).catch((err) => {
      console.error("❌ safeEasySystemCall failed:", err?.message || err);
      return triggerAgentTransfer(
        data,
        callback, "Please hold while I transfer you to an agent."
      );
    });
  },

  manage_existing_users: function (data, callback) {
    const text = "I want to manage an existing user on my Staples account (edit details, change roles/permissions, or deactivate).";
    const correlationId = enhancedLogger.generateCorrelationId();
    const requestData = makeRequestData(data, text);

    safeEasySystemCall(
      "easysystem-send-api",
      easysytemUrl,
      requestData,
      data,
      callback,
      correlationId,
      (response, data, callback) => {
        console.log("Easysystem response:", JSON.stringify(response.data));
        data.message = response.data.text;
        handleAgentTransfer({ response, data, callback, sdk });
        return sdk.sendUserMessage(data, callback);
      }
    ).catch((err) => {
      console.error("❌ safeEasySystemCall failed:", err?.message || err);
      return triggerAgentTransfer(
        data,
        callback, "Please hold while I transfer you to an agent."
      );
    });
  },

  reset_password: function (data, callback) {
    const text = "Reset the password";
    const correlationId = enhancedLogger.generateCorrelationId();
    const requestData = makeRequestData(data, text);

    safeEasySystemCall(
      "easysystem-send-api",
      easysytemUrl,
      requestData,
      data,
      callback,
      correlationId,
      (response, data, callback) => {
        console.log("Easysystem response:", JSON.stringify(response.data));
        data.context.session.BotUserSession.resetMessage = response.data.text;
        data.context.session.BotUserSession.content = response.data.contentType;
        handleAgentTransfer({ response, data, callback, sdk });
        return sdk.sendUserMessage(data, callback);
      }
    ).catch((err) => {
      console.error("❌ safeEasySystemCall failed:", err?.message || err);
      return triggerAgentTransfer(
        data,
        callback, "Please hold while I transfer you to an agent."
      );
    });
  },

  reset_password_handler: function (data, callback) {
    const text = "Reset the password";
    const correlationId = enhancedLogger.generateCorrelationId();
    const requestData = makeRequestData(data, text);

    safeEasySystemCall(
      "easysystem-send-api",
      easysytemUrl,
      requestData,
      data,
      callback,
      correlationId,
      (response, data, callback) => {
        console.log("Easysystem response:", JSON.stringify(response.data));
        data.message = response.data.text;
        handleAgentTransfer({ response, data, callback, sdk });
        return sdk.sendUserMessage(data, callback);
      }
    ).catch((err) => {
      console.error("❌ safeEasySystemCall failed:", err?.message || err);
      return triggerAgentTransfer(
        data,
        callback, "Please hold while I transfer you to an agent."
      );
    });
  },

  invoice_or_packing_slip: function (data, callback) {
    const text = "I need help with an invoice or packing slip.";
    const correlationId = enhancedLogger.generateCorrelationId();
    const requestData = makeRequestData(data, text);

    safeEasySystemCall(
      "easysystem-send-api",
      easysytemUrl,
      requestData,
      data,
      callback,
      correlationId,
      (response, data, callback) => {
        console.log("Easysystem response:", JSON.stringify(response.data));
        data.message = response.data.text;
        handleAgentTransfer({ response, data, callback, sdk });
        return sdk.sendUserMessage(data, callback);
      }
    ).catch((err) => {
      console.error("❌ safeEasySystemCall failed:", err?.message || err);
      return triggerAgentTransfer(
        data,
        callback, "Please hold while I transfer you to an agent."
      );
    });
  },

  modify_shipping_location: function (data, callback) {
    const text = "I want to modify an existing shipping location on my Staples account";
    const correlationId = enhancedLogger.generateCorrelationId();
    const requestData = makeRequestData(data, text);

    safeEasySystemCall(
      "easysystem-send-api",
      easysytemUrl,
      requestData,
      data,
      callback,
      correlationId,
      (response, data, callback) => {
        console.log("Easysystem response:", JSON.stringify(response.data));
        data.message = response.data.text;
        handleAgentTransfer({ response, data, callback, sdk });
        return sdk.sendUserMessage(data, callback);
      }
    ).catch((err) => {
      console.error("❌ safeEasySystemCall failed:", err?.message || err);
      return triggerAgentTransfer(
        data,
        callback, "Please hold while I transfer you to an agent."
      );
    });
  },

  account_id_handler: function (data, callback) {
    const text = "I need help with my account or user ID.";
    const correlationId = enhancedLogger.generateCorrelationId();
    const requestData = makeRequestData(data, text);

    safeEasySystemCall(
      "easysystem-send-api",
      easysytemUrl,
      requestData,
      data,
      callback,
      correlationId,
      (response, data, callback) => {
        console.log("Easysystem response:", JSON.stringify(response.data));
        data.message = response.data.text;
        handleAgentTransfer({ response, data, callback, sdk });
        return sdk.sendUserMessage(data, callback);
      }
    ).catch((err) => {
      console.error("❌ safeEasySystemCall failed:", err?.message || err);
      return triggerAgentTransfer(
        data,
        callback, "Please hold while I transfer you to an agent."
      );
    });
  },

  missing_item: function (data, callback) {
    const text = "I need help with a missing item from my order.";
    const correlationId = enhancedLogger.generateCorrelationId();
    const requestData = makeRequestData(data, text);

    safeEasySystemCall(
      "easysystem-send-api",
      easysytemUrl,
      requestData,
      data,
      callback,
      correlationId,
      (response, data, callback) => {
        console.log("Easysystem response:", JSON.stringify(response.data));
        data.message = response.data.text;
        handleAgentTransfer({ response, data, callback, sdk });
        return sdk.sendUserMessage(data, callback);
      }
    ).catch((err) => {
      console.error("❌ safeEasySystemCall failed:", err?.message || err);
      return triggerAgentTransfer(
        data,
        callback, "Please hold while I transfer you to an agent."
      );
    });
  },
};