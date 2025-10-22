const { getBotConfig, getBotUrls } = require("./lib/config");

let ErrorHandler,
  CircuitBreaker,
  SessionManager,
  ApiClientWrapper,
  EnhancedLogger,
  HealthMonitor;

try {
  ErrorHandler = require("./start/shared/error-handler");
  CircuitBreaker = require("./start/shared/circuit-breaker");
  SessionManager = require("./start/shared/session-manager");
  EnhancedLogger = require("./start/shared/enhanced-logger");
  const HMMod = require("./start/shared/health-monitor");
  const RAIMod = require("./start/shared/resilient-api-client");
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
  console.warn(
    "⚠️  Shared components not found, using fallback implementations"
  );
  console.warn("⚠️  Error:", error.message);

  ErrorHandler = { handleError: (error, context, callback) => callback(error) };
  CircuitBreaker = {
    canExecute: () => true,
    recordSuccess: () => {},
    recordFailure: () => {},
  };
  SessionManager = { cleanup: () => {} };

  const crypto = require("crypto");
  EnhancedLogger = {
    generateCorrelationId: () =>
      crypto.randomUUID
        ? crypto.randomUUID()
        : crypto.randomBytes(16).toString("hex"),
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

const botName = "EasySystemSBA";
const botConfig = getBotConfig(botName);
const botUrls = getBotUrls(botName);

console.log("🔍 DEBUG: botName:", botName);
console.log("🔍 DEBUG: botConfig:", JSON.stringify(botConfig, null, 2));
console.log("🔍 DEBUG: botConfig.botIds:", botConfig.botIds);

var sdk = require("./lib/sdk");
var Promise = sdk.Promise;
var { makeHttpCall } = require("./makeHttpCall");
const axios = require("axios");
let logger;
try {
  logger = require("./lib/logger");
} catch (e) {
  logger = console;
}

const enhancedLogger = EnhancedLogger;
const errorHandler = ErrorHandler;
const circuitBreaker = CircuitBreaker;
const sessionManager = SessionManager;

const healthMonitor = new HealthMonitor({
  instanceId: "es-sba-bot",
  cleanupInterval: 1800000,
});

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
  console.warn("⚠️  ApiClientWrapper failed, using axios fallback");
  console.warn("⚠️  Error:", error.message);

  apiClient = {
    post: async (url, data, options = {}) => {
      try {
        const response = await axios.post(url, data, {
          timeout: options.timeout || 30000,
          headers: options.headers || { "Content-Type": "application/json" },
        });
        return response;
      } catch (error) {
        throw error;
      }
    },
    get: async (url, options = {}) => {
      try {
        const response = await axios.get(url, {
          timeout: options.timeout || 30000,
          headers: options.headers || { "Content-Type": "application/json" },
        });
        return response;
      } catch (error) {
        throw error;
      }
    },
  };
  console.log("✅ Axios fallback initialized successfully");
}

var easysytemUrl = botUrls.sendMessage;
var easysytemSaveMessageUrl = botUrls.saveMessage;
var contextUrl = botUrls.contextLoad;

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
  } catch (e) {
    return sdk.sendBotMessage(data, callback);
  }
}

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
    if (
      !(await Promise.resolve(circuitBreaker.canExecute(serviceName)))
    ) {
      enhancedLogger.warn(
        "CIRCUIT_BREAKER_OPEN",
        {
          service: serviceName,
          conversationId:
            data.context?.session?.BotUserSession?.conversationSessionId,
        },
        correlationId
      );

      return triggerAgentTransfer(
        data,
        callback,
        "Please hold while I transfer you to an agent."
      );
    }

    enhancedLogger.logApiCallStart(url, requestData, correlationId);

    const response = await apiClient.post(url, requestData, {
      headers: {
        "Content-Type": "application/json",
        "business-unit": data.context.session.BotUserSession.businessUnit,
      },
      timeout: 30000,
      data, // <-- pass UserSession context for circuit breaker
    });

    await Promise.resolve(circuitBreaker.recordSuccess("easysystem-api", data));
    enhancedLogger.logApiCallComplete(url, response, correlationId);

    if (response?.data?.transfer === true || data.agent_transfer === true) {
      return triggerAgentTransfer(data, callback, response?.data?.text);
    }

    return originalCallback(response, data, callback);
  } catch (error) {
    await Promise.resolve(
      circuitBreaker.recordFailure("easysystem-api", data, error)
    );
    enhancedLogger.logApiCallError(url, error, correlationId);

    const errText = "Please hold while I transfer you to an agent.";
    return triggerAgentTransfer(data, callback, errText);
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
  // Use the provided correlationId if present; otherwise generate one
  const cid = correlationId ?? enhancedLogger.generateCorrelationId();

  try {
    const canCall = await Promise.resolve(
      circuitBreaker.canExecute("easysystem-save-api", data)
    );
    if (!canCall) {
      enhancedLogger.warn(
        "CIRCUIT_BREAKER_OPEN",
        {
          service: "easysystem-save-api",
          conversationId:
            data?.context?.session?.BotUserSession?.conversationSessionId,
        },
        cid
      );
      if (typeof errorCallback === "function") errorCallback();
    }
    await apiClient.post(url, messageSaveData, {
      headers: {
        "Content-Type": "application/json",
        "X-Correlation-Id": cid,
      },
      timeout: 30000,
      // If your apiClient inspects config.data for context, keep it;
      // otherwise remove to avoid confusion with axios semantics.
      data, // pass UserSession context for circuit breaker or middleware
    });
    // Mark success in the breaker
    await Promise.resolve(circuitBreaker.recordSuccess("easysystem-save-api"));

    enhancedLogger.info(
      "MESSAGE_SAVED_TO_EASYSYSTEM",
      { conversationId: messageSaveData?.externalConversationId },
      cid
    );

    if (typeof successCallback === "function") successCallback();
  } catch (saveError) {
    // Mark failure in the breaker
    try {
      await Promise.resolve(
        circuitBreaker.recordFailure("easysystem-save-api", saveError)
      );
    } catch (_) {
      /* best effort */
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

healthMonitor.start();

function processEasySystemResponse(data, responseData) {
  console.warn(responseData.text);
  data.message = responseData.text;
  if (!responseData.transfer && !responseData.endConversation) {
    data.context.session.UserSession.owner = "easysystem";
  }
  if (responseData.transfer) {
    data.agent_transfer = true;
    data.context.session.UserSession.owner = "kore";
  }
  if (responseData.endConversation) {
    data.context.session.BotUserSession.endConversationFromEasySystem =
      responseData.endConversation;
    data.context.session.UserSession.owner = "kore";
  }
}

// =============================
// SBA (SA) ADDITIONS - HELPERS
// =============================

function buOf(data) {
  return data?.context?.session?.BotUserSession?.businessUnit || "SA";
}

function pickFirst(...vals) {
  for (const v of vals) if (v !== undefined && v !== null && v !== "") return v;
  return undefined;
}

function buildEasySystemContextPayload(data) {
  const s = data.context?.session || {};
  const bu = s.BotUserSession?.businessUnit || "SA";
  const convId = s.BotUserSession?.conversationSessionId;

  const e = data.context?.entities || {};
  const profile = s.BotUserSession?.userProfile || {};
  const user = s.UserSession || {};
  const cd = s.BotUserSession?.customData || {};

  const cartFirstZip = cd.cart?.lines?.[0]?.zipcode;

  const ACCOUNT_NUMBER = pickFirst(
    e.ACCOUNT_NUMBER,
    profile.ACCOUNT_NUMBER,
    user.ACCOUNT_NUMBER,
    cd.accountNumber,
    cd.master
  );
  const DIVISION = pickFirst(e.DIVISION, profile.DIVISION, user.DIVISION, cd.div);
  const USER_ID = pickFirst(
    e.USER_ID,
    profile.USER_ID,
    user.USER_ID,
    profile.userId,
    cd.newUserID,
    cd.userid
  );
  const CUSTOMER_NUMBER = pickFirst(
    e.CUSTOMER_NUMBER,
    profile.CUSTOMER_NUMBER,
    user.CUSTOMER_NUMBER,
    cd.accountNumber,
    cd.master
  );
  const ORDER_NUMBER = pickFirst(
    e.ORDER_NUMBER,
    e.orderNumberCollect,
    e.orderNumberEntity,
    e.orderEntity
  );
  const EMAIL = pickFirst(e.EMAIL, profile.EMAIL, user.emailId, user.email, cd.email);
  const ZIPCODE = pickFirst(
    e.ZIPCODE,
    e.zipCodeCollect,
    e.zipCodeEntity,
    e.zipEntity,
    e.ZipCodeReturn,
    e.getZipCode,
    e.modifyZipCode,
    cd.zipcode,
    cd.shiptozipcode,
    cartFirstZip
  );

  const isLoggedIn = String(
    Boolean(
      pickFirst(
        s.BotUserSession?.isLoggedIn,
        user.isLoggedIn,
        profile.isLoggedIn,
        cd.loggedIn,
        EMAIL || CUSTOMER_NUMBER
      )
    )
  );

  return {
    headers: { "Content-Type": "application/json", "business-unit": bu },
    body: {
      externalConversationId: convId,
      conversationId: convId,
      assistantType: "STANDARD",
      entityMap: {
        ...(CUSTOMER_NUMBER ? { CUSTOMER_NUMBER: String(CUSTOMER_NUMBER) } : {}),
        ...(ORDER_NUMBER ? { ORDER_NUMBER: String(ORDER_NUMBER) } : {}),
        ...(EMAIL ? { EMAIL: String(EMAIL) } : {}),
        ...(ACCOUNT_NUMBER ? { ACCOUNT_NUMBER: String(ACCOUNT_NUMBER) } : {}),
        ...(DIVISION ? { DIVISION: String(DIVISION) } : {}),
        ...(USER_ID ? { USER_ID: String(USER_ID) } : {}),
        ...(ZIPCODE ? { ZIPCODE: String(ZIPCODE) } : {}),
      },
      loggedIn: isLoggedIn,
      channel: "Kore",
    },
  };
}

function getIsLoggedIn(data) {
  try {
    const { body } = buildEasySystemContextPayload(data);
    return body.loggedIn; // "true" or "false"
  } catch (_) {
    return "false";
  }
}

function easyHeaders(data) {
  return {
    "Content-Type": "application/json",
    "business-unit": buOf(data),
    isLoggedIn: getIsLoggedIn(data),
  };
}

async function sendContextToEasySystem(data) {
  const correlationId = enhancedLogger.generateCorrelationId();
  try {
    const allow = await Promise.resolve(
      circuitBreaker.canExecute("easysystem-context-api", data)
    );
    if (!allow) {
      enhancedLogger.warn(
        "CIRCUIT_BREAKER_OPEN",
        {
          service: "easysystem-context-api",
          conversationId:
            data?.context?.session?.BotUserSession?.conversationSessionId,
        },
        correlationId
      );
      return;
    }

    const { body } = buildEasySystemContextPayload(data);
    const headers = { ...easyHeaders(data) };

    enhancedLogger.logApiCallStart(contextUrl, body, correlationId);

    await apiClient.post(contextUrl, body, {
      headers,
      timeout: 30000,
      data,
    });

    await Promise.resolve(
      circuitBreaker.recordSuccess("easysystem-context-api", data)
    );
    enhancedLogger.logApiCallComplete(contextUrl, { data: { ok: true } }, correlationId);
  } catch (err) {
    try {
      await Promise.resolve(
        circuitBreaker.recordFailure("easysystem-context-api", data, err)
      );
    } catch (_) {}
    enhancedLogger.logApiCallError(contextUrl, err, correlationId);
  }
}

async function easySendText(data, text) {
  const correlationId = enhancedLogger.generateCorrelationId();
  const payload = {
    text,
    externalConversationId: data.context.session.BotUserSession.conversationSessionId,
    conversationId: data.context.session.BotUserSession.conversationSessionId,
    businessUnit: buOf(data),
  };
  try {
    const allow = await Promise.resolve(
      circuitBreaker.canExecute("easysystem-send-api", data)
    );
    if (!allow) {
      const err = new Error("Circuit breaker open for easysystem-send-api");
      err.code = "CIRCUIT_OPEN";
      throw err;
    }

    enhancedLogger.logApiCallStart(easysytemUrl, payload, correlationId);

    const res = await apiClient.post(easysytemUrl, payload, {
      headers: { ...easyHeaders(data) },
      timeout: 30000,
      data,
    });

    await Promise.resolve(
      circuitBreaker.recordSuccess("easysystem-send-api", data)
    );
    enhancedLogger.logApiCallComplete(easysytemUrl, res, correlationId);
    return res.data;
  } catch (error) {
    try {
      await Promise.resolve(
        circuitBreaker.recordFailure("easysystem-send-api", data, error)
      );
    } catch (_) {}
    enhancedLogger.logApiCallError(easysytemUrl, error, correlationId);
    throw error;
  }
}

// =============================
// SBA (SA) ADDITIONS - OUTCOME HANDLERS
// =============================

function handleEasySendOutcome_Direct(tag, data, responseData, callback) {
  console.log(`${tag} Response:`, responseData);
  console.log("is conversation end =", responseData?.endConversation);
  console.log("Transfer to agent =", responseData?.transfer);

  data.message = responseData?.text || "";
  // Always pass an explicit agent handoff message if transfer
  const handoffMsg = responseData?.text || "Please hold while I transfer you to an agent.";

  if (responseData?.transfer) {
    data.context.session.BotUserSession.transfer = true;
    console.log(`[${tag}] First message is agent transfer — escalating.`);
    if (data._via_webhook) {
      // In webhook context, don't send messages here; just flag and return
      data.agent_transfer = true;
      data.context.session.UserSession.owner = "kore";
      return callback(null, data);
    }
    return triggerAgentTransfer(data, callback, handoffMsg);
  }

  if (responseData?.endConversation) {
    data.context.session.BotUserSession.endConversationFromEasySystem = true;
    data.context.session.UserSession.owner = "kore";
  }

  // For webhook context we still allow direct-send integrations to push messages,
  // matching Quill behavior for direct flows.
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

// =============================
// EXPORTS (Base Quill  SBA)
// =============================

module.exports = {
  botId: botConfig.botIds,
  botName: botName,
  on_client_event: function (requestId, data, callback) {
    return callback(null, data);
  },
  on_user_message: function (requestId, data, callback) {
    const correlationId = enhancedLogger.generateCorrelationId();

    try {

      let session_owner = data.context.session.UserSession.owner;
      if (
        !data.context.session.BotUserSession.businessUnit ||
        data.context.session.BotUserSession.businessUnit === null ||
        data.context.session.BotUserSession.businessUnit === undefined
      ) {
        console.log("businessUnit is null or empty, not saving the message");
        return sdk.sendBotMessage(data, callback);
      }
      if (
        !data.message ||
        data.message === null ||
        data.message.trim() === ""
      ) {
        console.log("message is null or empty, not saving the message");
        return sdk.sendBotMessage(data, callback);
      }
      console.log(
        "businessUnit: " + data.context.session.BotUserSession.businessUnit
      );

      if (session_owner === "easysystem") {
        const requestData = {
          text: data.message,
          conversationId:
            data.context.session.BotUserSession.conversationSessionId,
          businessUnit: data.context.session.BotUserSession.businessUnit,
        };
        const messageSaveData = {
          text: data.message,
          externalConversationId:
            data.context.session.BotUserSession.conversationSessionId,
          businessUnit: data.context.session.BotUserSession.businessUnit,
          role: "user",
          channel: "Kore",
        };
        console.log("Saving message to Easy System" + data.message);

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
            console.log(
              "is conversation end = " + response.data.conversationEnd
            );

            if (!!response.data.conversationEnd) {
              console.log("setting owner as kore");
              data.context.session.UserSession.owner = "kore";
            }

            sdk.sendUserMessage(data, callback);
          }
        )
          .then(() => {
            console.log("✅ safeEasySystemCall completed successfully.");
          })
          .catch((err) => {
            console.error("❌ safeEasySystemCall failed:", err?.message || err);
            triggerAgentTransfer(
              data,
              callback,
              "Please hold while I transfer you to an agent."
            );
          });
      } else {
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
                "on_user_message:: easysystem message saved for conversationId " 
                 + messageSaveData.externalConversationId
              );
            },
            (error) => {
              console.error(
                "Error updating easysystem context:",
                error.response ? error.response.data : error.message
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
        callback,
        "Please hold while I transfer you to an agent."
      );
    }
  },

  on_bot_message: function (requestId, data, callback) {
    const correlationId = enhancedLogger.generateCorrelationId();
    try {
      let session_owner = data.context.session.UserSession.owner;
      if (
        !data.context.session.BotUserSession.businessUnit ||
        data.context.session.BotUserSession.businessUnit === null ||
        data.context.session.BotUserSession.businessUnit === undefined
      ) {
        console.log("businessUnit is null or empty, not saving the message");
        return sdk.sendUserMessage(data, callback);
      }
      if (
        !data.message ||
        data.message === null ||
        data.message.trim() === ""
      ) {
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
              "on_user_message:: easysystem message saved for conversationId " 
               + messageSaveData.externalConversationId
            );
          },
          (error) => {
            console.error(
              "Error updating easysystem context:",
              error.response ? error.response.data : error.message
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
        callback,
        "Please hold while I transfer you to an agent."
      );
    }
  },

  on_webhook: function (requestId, data, componentName, callback) {
    const correlationId = enhancedLogger.generateCorrelationId();

    try {
      console.log("component name: " + componentName);

      var contextData = {
        externalConversationId:
          data.context.session.BotUserSession.conversationSessionId,
        conversationId:
          data.context.session.BotUserSession.conversationSessionId,
        assistantType: "STANDARD",
        channel: "Kore",
      };

      // SBA webhook map (additional integrations)
      const webhookMap = {
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
        MissingHook: "missing_item",
      };

      const SCRIPT_MODE = new Set([]);

      const integName = webhookMap[componentName];

      // ACK webhook immediately to avoid RequestAgent/ESOCKETTIMEDOUT
      try {
        data.status = "success";
        if (typeof sdk.sendWebhookResponse === "function") {
          sdk.sendWebhookResponse(data, callback);
        } else {
          callback(null, data);
        }
      } catch (_) {
        // best-effort ack; continue processing
      }

        // Continue processing asynchronously after ACK
        setImmediate(() => {
          const asyncCb = (err) => {
            if (err) console.error("Async post-ACK error:", err);
          };
          
          // SBA Business Unit handling for easySystemHook
          if (
            componentName === "easySystemHook" &&
            data.context.session.BotUserSession.businessUnit === "SA"
          ) {
            console.log("SBA Business Unit");
            contextData.entityMap =
              data.context.session.BotUserSession.entityPayload;

            safeEasySystemCall(
              "easysystem-context-api",
              contextUrl,
              contextData,
              data,
              asyncCb,
              correlationId,
              (response, data, callback) => {
                console.log(
                  "Context updated for conversationId " 
                   + contextData.externalConversationId
                );
                integrations.package_tracking_handover(data, asyncCb);
              }
            );
            return;
          }

        // SBA additional component handlers (additive)
        if (integName && typeof integrations[integName] === "function") {
          const isScriptMode = SCRIPT_MODE.has(integName);

          if (isScriptMode) {
            data._via_webhook = true; // informational only
          sendContextToEasySystem(data)
              .finally(() => {
              integrations[integName](data, (err, _updated) => {
                  if (err) console.error(`${integName} integration error:`, err);
                  // already ACKed
                });
              });
            return;
          }

          // Direct-send: integration will send message immediately; webhook already ACKed
          sendContextToEasySystem(data)
            .finally(() => {
              integrations[integName](data, (err, _updated) => {
                if (err) console.error(`${integName} integration error:`, err);
                return; 
              });
            });
          return;
        }

        // nothing else to do post-ACK
        return;
      });
      return;
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
        callback,
        "Please hold while I transfer you to an agent."
      );
    }
  },

  on_event: function (requestId, data, callback) {
    return callback(null, data);
  },

  getHealthStatus: async function () {
    return await healthMonitor.getHealthStatus();
  },

  cleanup: function () {
    sessionManager.cleanup();
    healthMonitor.stop();
    enhancedLogger.info("ES-Quill Bot cleanup completed");
  },
};

// =============================
// Integrations (Base  SBA)
// =============================

const integrations = {
  // === SBA: DIRECT-SEND integrations ===
  package_tracking_handover: function (data, callback) {
    const orderNumber = data.context.orderNumber;
    const zipCode = data.context.zipCode;
    const text = `can you help me track my order? My order number is ${orderNumber} and zip code is ${zipCode}`;
    easySendText(data, text)
      .then((res) => handleEasySendOutcome_Direct("Package Tracking", data, res, callback))
      .catch((err) => handleEasySendError_Direct("Package Tracking", data, err, callback));
  },

  Check_Return: function (data, callback) {
    const orderNumber = data.context.orderNumber;
    const zipCode = data.context.zipCode;
    const text = `Check the status for Return an order with order number ${orderNumber} and ZipCode ${zipCode}`;
    easySendText(data, text)
      .then((res) => handleEasySendOutcome_Direct("Return Status", data, res, callback))
      .catch((err) => handleEasySendError_Direct("Return Status", data, err, callback));
  },

  // === SBA: DIRECT-SEND integrations ===
  Cancel_item: function (data, callback) {
    const orderNumber = data.context.orderNumberForCancelItem;
    const zipCode = data.context.zipcodeForCancelItem;
    const text = `Cancel Item having Order Number ${orderNumber} and ZipCode ${zipCode}`;
    easySendText(data, text)
      .then((res) => handleEasySendOutcome_Direct("Cancel Item", data, res, callback))
      .catch((err) => handleEasySendError_Direct("Cancel Item", data, err, callback));
  },

  add_new_user_handler: function (data, callback) {
    const text = "I want to add a new user to my Staples account.";
    easySendText(data, text)
      .then((res) => handleEasySendOutcome_Direct("Add New User", data, res, callback))
      .catch((err) => handleEasySendError_Direct("Add New User", data, err, callback));
  },

  Cancel_Entire_order: function (data, callback) {
    const orderNumber = data.context.orderNumberForCancelOrder;
    const zipCode = data.context.zipcodeForCancelOrder;
    const text = `Cancel the Entire Order having Order Number ${orderNumber} and ZipCode ${zipCode}`;
    easySendText(data, text)
      .then((res) => handleEasySendOutcome_Direct("Cancel Entire Order", data, res, callback))
      .catch((err) => handleEasySendError_Direct("Cancel Entire Order", data, err, callback));
  },

  Refund_Check: function (data, callback) {
    const text = "I want to check my refund status.";
    easySendText(data, text)
      .then((res) => handleEasySendOutcome_Direct("Refund", data, res, callback))
      .catch((err) => handleEasySendError_Direct("Refund", data, err, callback));
  },

  Exchange_Item: function (data, callback) {
    const text = "I want to return or exchange an item.";
    easySendText(data, text)
      .then((res) => handleEasySendOutcome_Direct("Exchange", data, res, callback))
      .catch((err) => handleEasySendError_Direct("Exchange", data, err, callback));
  },

  change_shipping_address: function (data, callback) {
    const text =
      "I want to add a new shipping location to my Staples account (enter address, set delivery preferences, and update contact details).";
    easySendText(data, text)
      .then((res) => handleEasySendOutcome_Direct("Shipping Address", data, res, callback))
      .catch((err) => handleEasySendError_Direct("Shipping Address", data, err, callback));
  },

  manage_existing_users: function (data, callback) {
    const text =
      "I want to manage an existing user on my Staples account (edit details, change roles/permissions, or deactivate).";
    easySendText(data, text)
      .then((res) => handleEasySendOutcome_Direct("Manage Existing User", data, res, callback))
      .catch((err) => handleEasySendError_Direct("Manage Existing User", data, err, callback));
  },

  reset_password: function (data, callback) {
    const text = "Reset the password";
    easySendText(data, text)
      .then((res) => handleEasySendOutcome_Direct("Reset Password", data, res, callback))
      .catch((err) => handleEasySendError_Direct("Reset Password", data, err, callback));
  },

  reset_password_handler: function (data, callback) {
    const text = "Reset the password";
    easySendText(data, text)
      .then((res) => handleEasySendOutcome_Direct("Reset Password Hook", data, res, callback))
      .catch((err) => handleEasySendError_Direct("Reset Hook", data, err, callback));
  },

  invoice_or_packing_slip: function (data, callback) {
    const text = "I need help with an invoice or packing slip.";
    easySendText(data, text)
      .then((res) => handleEasySendOutcome_Direct("Invoice", data, res, callback))
      .catch((err) => handleEasySendError_Direct("Invoice", data, err, callback));
  },

  modify_shipping_location: function (data, callback) {
    const text = "I want to modify an existing shipping location on my Staples account";
    easySendText(data, text)
      .then((res) => handleEasySendOutcome_Direct("Modify Shipping", data, res, callback))
      .catch((err) => handleEasySendError_Direct("Modify Shipping", data, err, callback));
  },

  account_id_handler: function (data, callback) {
    const text = "I need help with my account or user ID.";
    easySendText(data, text)
      .then((res) => handleEasySendOutcome_Direct("Account ID", data, res, callback))
      .catch((err) => handleEasySendError_Direct("Account ID", data, err, callback));
  },

  missing_item: function (data, callback) {
    const text = "I'm missing an item from my order.";
    easySendText(data, text)
      .then((res) => handleEasySendOutcome_Direct("Missing Item", data, res, callback))
      .catch((err) => handleEasySendError_Direct("Missing Item", data, err, callback));
  },
};

// Support consumers that import default export
try {
  module.exports.default = module.exports;
} catch (_) {}