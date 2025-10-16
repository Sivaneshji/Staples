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
 
const botName = "EasySystemQuill";
const botConfig = getBotConfig(botName);
const botUrls = getBotUrls(botName);
 
console.log("🔍 DEBUG: botName:", botName);
console.log("🔍 DEBUG: botConfig:", JSON.stringify(botConfig, null, 2));
console.log("🔍 DEBUG: botConfig.botIds:", botConfig.botIds);
 
var sdk = require("./lib/sdk");
var Promise = sdk.Promise;
var { makeHttpCall } = require("./makeHttpCall");
const axios = require("axios");
const logger = require("./lib/logger");
 
const enhancedLogger = EnhancedLogger;
const errorHandler = ErrorHandler;
const circuitBreaker = CircuitBreaker;
const sessionManager = SessionManager;
 
const healthMonitor = new HealthMonitor({
  instanceId: "es-quill-bot",
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
 
module.exports = {
  botId: botConfig.botIds,
  botName: botName,
  on_client_event: function (requestId, data, callback) {
    //const userId = getUserId(data);
    //clearInactivityTimer(userId);
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
                "on_user_message:: easysystem message saved for conversationId " +
                  messageSaveData.externalConversationId
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
              "on_user_message:: easysystem message saved for conversationId " +
                messageSaveData.externalConversationId
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
      //console.log("on_webhook: " + JSON.stringify(data));
      console.log("component name: " + componentName);
 
      var contextData = {
        externalConversationId:
          data.context.session.BotUserSession.conversationSessionId,
        conversationId:
          data.context.session.BotUserSession.conversationSessionId,
        assistantType: "STANDARD",
        channel: "Kore",
      };
 
      if (
        componentName === "easySystemHook" &&
        data.context.session.BotUserSession.businessUnit === "Q"
      ) {
        console.log("Quill Business Unit");
        contextData.entityMap =
          data.context.session.BotUserSession.entityPayload;
 
        safeEasySystemCall(
          "easysystem-context-api",
          contextUrl,
          contextData,
          data,
          callback,
          correlationId,
          (response, data, callback) => {
            console.log(
              "✅ Context updated for conversationId " +
                contextData.externalConversationId
            );
          }
        )
          .then(() => {
            // Only runs AFTER safeEasySystemCall completes successfully
            integrations.package_tracking_handover(data, callback);
          })
          .catch((err) => {
            console.error(
              "❌ Failed to update context before package tracking:",
              err?.message || err
            );
            triggerAgentTransfer(
              data,
              callback,
              "Please hold while I transfer you to an agent."
            );
          });
      } else if (
        componentName === "easySystemHook" &&
        data.context.session.BotUserSession.businessUnit === "C"
      ) {
        console.log("DOTCOM Business Unit");
        contextData.entityMap =
          data.context.session.BotUserSession.entityPayload;
 
        safeEasySystemCall(
          "easysystem-context-api",
          contextUrl,
          contextData,
          data,
          callback,
          (response, data, callback) => {
            console.log(
              "Context updated for conversationId " +
                contextData.externalConversationId
            );
            integrations.package_tracking_handover(data, callback);
          }
        );
      } else if (
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
          callback,
          (response, data, callback) => {
            console.log(
              "Context updated for conversationId " +
                contextData.externalConversationId
            );
            integrations.package_tracking_handover(data, callback);
          }
        );
      } else {
        return sdk.sendWebhookResponse(data, callback);
      }
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
 
const integrations = {
  package_tracking_handover: function (data, callback) {
    const correlationId = enhancedLogger.generateCorrelationId();
 
    try {
      const orderNumber =
        data.context.AI_Assisted_Dialogs.collectInfoTrack.entities
          .orderNumber || data.context.session.BotUserSession.orderNumber;
      const zipCode =
        data.context.AI_Assisted_Dialogs.collectInfoTrack.entities.zipCode ||
        data.context.session.BotUserSession.zipCode;
 
      const requestData = {
        text: `can you help me track my order? My order number is ${orderNumber} and zip code is ${zipCode}`,
        externalConversationId:
          data.context.session.BotUserSession.conversationSessionId,
        conversationId:
          data.context.session.BotUserSession.conversationSessionId,
        businessUnit: data.context.session.BotUserSession.businessUnit,
      };
 
      // ⏳ Wait for safeEasySystemCall to finish before responding
      safeEasySystemCall(
        "easysystem-send-api",
        easysytemUrl,
        requestData,
        data,
        callback,
        correlationId,
        (response, data, callback) => {
          try {
            console.log("Easysystem response:", JSON.stringify(response.data));
            processEasySystemResponse(data, response.data);
            if (response.data.transfer || data.agent_transfer === true) {
              data.context.session.BotUserSession.transfer = true;
              return sdk.sendBotMessage(data, callback);
            }
            if (response.data.endConversation) {
              data.context.session.BotUserSession.endConversationFromEasySystem = true;
            }
            // ✅ Once EasySystem response is processed, send user message
            return sdk.sendUserMessage(data, callback);
          } catch (innerError) {
            console.error("Error processing EasySystem response:", innerError);
            return triggerAgentTransfer(
              data,
              callback,
              "Please hold while I transfer you to an agent."
            );
          }
        }
      )
        .then(() => {
          // This runs *after* safeEasySystemCall has completed successfully
          console.log(
            "✅ safeEasySystemCall completed for package_tracking_handover"
          );
        })
        .catch((err) => {
          console.error("❌ safeEasySystemCall failed:", err?.message || err);
          triggerAgentTransfer(
            data,
            callback,
            "Please hold while I transfer you to an agent."
          );
        });
    } catch (error) {
      enhancedLogger.error(
        "PACKAGE_TRACKING_ERROR",
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
};