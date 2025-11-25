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

  // Support both default/named exports â€” becauseâ€¦ modules
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
  // No shared kit? No problem â€” keep the lights on with minimal fallbacks.
  console.warn("âš ï¸  Shared components not found, using fallback implementations");
  console.warn("âš ï¸  Error:", error.message);

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

console.log("ðŸ” DEBUG: botName:", botName);
console.log("ðŸ” DEBUG: botConfig:", JSON.stringify(botConfig, null, 2));
//console.log("ðŸ” DEBUG: botConfig.botIds:", botConfig.botIds);

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
  console.log("âœ… ApiClientWrapper initialized successfully");
} catch (error) {
  // If resilient client is missing, axios will do just fine.
  console.warn("âš ï¸  ApiClientWrapper failed, using axios fallback");
  console.warn("âš ï¸  Error:", error.message);

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
  console.log("âœ… Axios fallback initialized successfully");
}

// ---- Transfer helper -------------------------------------------------------------------------

function triggerAgentTransfer(data, callback, messageIfAny) {
  try {
    // Always send ES message if available, otherwise a fallback
    const finalMessage =
      (typeof messageIfAny === "string" && messageIfAny.trim() !== "")
        ? messageIfAny.trim()
        : "Sorry, unfortunately I'm not able to help you with that. Transferring you to a Staples Expert.";
    
    data.message = finalMessage;
    data.agent_transfer = true;

    if (data.context?.session?.BotUserSession) {
      data.context.session.BotUserSession.transfer = true;
    }
    if (data.context?.session?.UserSession) {
      data.context.session.UserSession.owner = "kore";
    }
    console.log("ðŸ” Triggering agent transfer with message:", finalMessage);
    return sdk.sendBotMessage(data, callback);
  } catch (e) {
    console.error("triggerAgentTransfer error:", e?.message || e);
    data.message =
      data.message ||
      "Sorry, unfortunately I'm not able to help you with that. Transferring you to a Staples Expert.";
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
  const transferMsg =
    (response?.data?.text && response.data.text.trim()) ||
    "Sorry, unfortunately I'm not able to help you with that. Transferring you to a Staples Expert.";
 
  // âœ… Ensure message is explicitly attached before sending
  data.message = transferMsg;
  console.log(response.data);
  console.log("ðŸš¦ ES indicated transfer. Sending message to user:", transferMsg);
 
  return triggerAgentTransfer(data, callback, "I am now connecting you with a Staples Expert.");
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

  // Channel/client events (typing, etc.) â€” nothing fancy here
  on_client_event: function (requestId, data, callback) {
    return callback(null, data);
  },

  // User â†’ bot messages
  on_user_message: function (requestId, data, callback) {
    const correlationId = enhancedLogger.generateCorrelationId();

    try {
      const session_owner = data.context.session.UserSession.owner;

      // Guardrails â€” if we don't have the basics, don't try to be clever.
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
              "âœ… Message saved successfully for conversationId:",
              messageSaveData.externalConversationId
            );
          },
          (err) => {
            console.error("âŒ Message save failed:", err?.message || err);
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
            console.log("âœ… safeEasySystemCall completed successfully.");
          })
          .catch((err) => {
            console.error("âŒ safeEasySystemCall failed:", err?.message || err);
            triggerAgentTransfer(
              data,
              callback, "Please hold while I transfer you to an agent."
            );
          });
      } else {
        // KORE owns the turn â€” save what the user said, let dialog do its thing
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

  // Bot â†’ user messages (save assistant outputs when KORE owns)
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

  // Webhooks from dialog nodes/routes
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

      // Friendly router: componentName -> integration method
      const routeTable = {
        easySystemHook: "package_tracking_handover",
        easySystemAddressChange: "change_shipping_address",
        easySystemHookstore: "finding_near_estore",
        resetPasswordWebHook: "reset_password",
        CheckReturnWebHook: "Check_Return",
        ExchangeWebHook: "Exchange_Item",
        RefundWebHook: "Refund_Check",
        CancelEntireOrderWebHook: "Cancel_Entire_order",
        CancelItemWebHook: "Cancel_item",
      };

      const integrationMethod = routeTable[componentName];

      if (!integrationMethod || typeof integrations[integrationMethod] !== "function") {
        // Not our route â€” hand control back to the platform
        return sdk.sendWebhookResponse(data, callback);
      }

      // ES context updates want entityMap as well
      contextData.entityMap = data.context.session.BotUserSession.entityPayload;

      // One-liner for â€œupdate ES context, *then* run integrationâ€
      return updateESContextThen(contextUrl, contextData, data, callback, () => {
        console.log(
          "Context updated for conversationId " + contextData.externalConversationId
        );
        return integrations[integrationMethod](data, callback);
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

// ---- Integrations (same behavior, less repetition) -------------------------------------------
// Tiny utilities shared by all integration calls

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

function runESFlow(data, callback, { text, onSuccess }) {
  const correlationId = enhancedLogger.generateCorrelationId();
  const requestData = makeRequestData(data, text);

  return safeEasySystemCall(
    "easysystem-send-api",
    easysytemUrl,
    requestData,
    data,
    callback,
    correlationId,
    (response, data, callback) => onSuccess(response, data, callback)
  ).catch((err) => {
    console.error("âŒ safeEasySystemCall failed:", err?.message || err);
    return triggerAgentTransfer(
      data,
      callback, "Please hold while I transfer you to an agent."
    );
  });
}

const integrations = {
  // Track order: stash ES response in trackOrder/content and hand turn to ES
  package_tracking_handover(data, callback) {
    const { orderNumber, zipCode } = data.context;
    const text = `can you help me track my order? My order number is ${orderNumber} and zip code is ${zipCode}`;

    return runESFlow(data, callback, {
      text,
      onSuccess: (response, data, callback) => {
        console.log("Easysystem response:", JSON.stringify(response.data));
        data.context.session.BotUserSession.trackOrder = response.data.text;
        data.context.session.BotUserSession.content = response.data.contentType;
        data.context.session.UserSession.owner = "easysystem";
        handleAgentTransfer({ response, data, callback, sdk });
        return sdk.sendUserMessage(data, callback);
      },
    });
  },

  // Find nearest stores and store the blob on the session
  finding_near_estore(data, callback) {
    const { zipCode } = data.context;
    const text =
      `Directly give all the information about three nearest store based on this zip code:${zipCode}` +
      `Give it all information at first go and DO not ask for permission.`;

    return runESFlow(data, callback, {
      text,
      onSuccess: (response, data, callback) => {
        console.log("Easysystem response:", JSON.stringify(response.data));
        data.context.session.BotUserSession.storeInfo = response.data.text;
        data.context.session.BotUserSession.content = response.data.contentType;
        handleAgentTransfer({ response, data, callback, sdk });
        return sdk.sendUserMessage(data, callback);
      },
    });
  },

  // Change shipping address
  change_shipping_address(data, callback) {
    const orderNumber = data.context.orderNumberForChangeAddress;
    const zipCode = data.context.zipcodeForChangeAddress;
    const text = `Change my shipping address having order number ${orderNumber} and zip code is ${zipCode}`;

    return runESFlow(data, callback, {
      text,
      onSuccess: (response, data, callback) => {
        console.log("Easysystem response:", JSON.stringify(response.data));
        data.message = response.data.text;
        handleAgentTransfer({ response, data, callback, sdk });
        return sdk.sendUserMessage(data, callback);
      },
    });
  },
  // Reset password
  reset_password(data, callback) {
    const text = "Reset the password";

    return runESFlow(data, callback, {
      text,
      onSuccess: (response, data, callback) => {
        console.log("Easysystem response:", JSON.stringify(response.data));
        data.context.session.BotUserSession.resetMessage = response.data.text;
        data.context.session.BotUserSession.content = response.data.contentType;
        handleAgentTransfer({ response, data, callback, sdk });
        return sdk.sendUserMessage(data, callback);
      },
    });
  },

  // Check return status
  Check_Return(data, callback) {
    const { orderNumber, zipCode } = data.context;
    const text = `Check the status for Return an order with order number ${orderNumber} and ZipCode ${zipCode}`;

    return runESFlow(data, callback, {
      text,
      onSuccess: (response, data, callback) => {
        console.log("Easysystem response:", JSON.stringify(response.data));
        data.context.session.BotUserSession.returnStatus = response.data.text;
        data.context.session.BotUserSession.content = response.data.contentType;
        // data.message = response.data.text;
        handleAgentTransfer({ response, data, callback, sdk });
        return sdk.sendUserMessage(data, callback);
      },
    });
  },

  // Exchange item
  Exchange_Item(data, callback) {
    const text = "Return or Exchange the Item";

    return runESFlow(data, callback, {
      text,
      onSuccess: (response, data, callback) => {
        console.log("Easysystem response:", JSON.stringify(response.data));
        data.message = response.data.text;
        handleAgentTransfer({ response, data, callback, sdk });
        return sdk.sendUserMessage(data, callback);
      },
    });
  },

  // Refund status
  Refund_Check(data, callback) {
    const text = "Refund Status Inquiry";

    return runESFlow(data, callback, {
      text,
      onSuccess: (response, data, callback) => {
        console.log("Easysystem response:", JSON.stringify(response.data));
        data.message = response.data.text;
        handleAgentTransfer({ response, data, callback, sdk });
        return sdk.sendUserMessage(data, callback);
      },
    });
  },

  // Cancel entire order
  Cancel_Entire_order(data, callback) {
    const orderNumber = data.context.orderNumberForCancelOrder;
    const zipCode = data.context.zipcodeForCancelOrder;
    const text = `Cancel the Entire Order having Order Number ${orderNumber} and ZipCode ${zipCode}`;

    return runESFlow(data, callback, {
      text,
      onSuccess: (response, data, callback) => {
        console.log("Easysystem response:", JSON.stringify(response.data));
        data.message = response.data.text;
        handleAgentTransfer({ response, data, callback, sdk });
        return sdk.sendUserMessage(data, callback);
      },
    });
  },

  // Cancel specific item
  Cancel_item(data, callback) {
    const orderNumber = data.context.orderNumberForCancelItem;
    const zipCode = data.context.zipcodeForCancelItem;
    const text = `Cancel Item having Order Number ${orderNumber} and ZipCode ${zipCode}`;

    return runESFlow(data, callback, {
      text,
      onSuccess: (response, data, callback) => {
        console.log("Easysystem response:", JSON.stringify(response.data));
        data.message = response.data.text;
        handleAgentTransfer({ response, data, callback, sdk });
        return sdk.sendUserMessage(data, callback);
      },
    });
  },
};