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
  console.warn("Ã¢Å¡ Ã¯Â¸Â  Shared components not found, using fallback implementations");
  console.warn("Ã¢Å¡ Ã¯Â¸Â  Error:", error.message);

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

console.log(`Initializing bot: ${botName}`);

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
  console.log("ApiClientWrapper initialized successfully");
} catch (error) {
  console.warn("Ã¢Å¡ Ã¯Â¸Â  ApiClientWrapper failed, using axios fallback");
  console.warn("Ã¢Å¡ Ã¯Â¸Â  Error:", error.message);

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
  console.log("Axios fallback initialized successfully");
}

var easysytemUrl = botUrls.sendMessage;
var easysytemSaveMessageUrl = botUrls.saveMessage;
var contextUrl = botUrls.contextLoad;

function triggerAgentTransfer(data, callback, messageIfAny) {
  messageIfAny="I am now connecting you with a staples expert";
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

function handleAgentTransfer({ response, data, callback, sdk }) {
  try {
    if (response?.data?.transfer) {
      data.context.session.BotUserSession.transfer = response.data.transfer;
      data.context.session.UserSession.owner = "kore";
      data.agent_transfer = true;
      sdk.sendBotMessage(data, callback);
      return true;
    }
  } catch (e) {
    console.error("handleAgentTransfer error:", e?.message || e);
  }
  return false;
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
    // ðŸª¶ ADDED: circuit breaker check remains same
    if (!(await Promise.resolve(circuitBreaker.canExecute(serviceName)))) {
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

    // ADDED: persistent headers to carry login + user context every turn
    const persistentHeaders = easyHeaders(data);

    // ADDED: quick debug log (visible in backend logs)
    enhancedLogger.info("EASYSYSTEM_CALL_HEADERS", {
      url,
      headers: persistentHeaders,
      conversationId:
        data.context?.session?.BotUserSession?.conversationSessionId,
    });

    enhancedLogger.logApiCallStart(url, requestData, correlationId);

    // ðŸª¶ REPLACED this block to always include persistentHeaders
    const response = await apiClient.post(url, requestData, {
      headers: {
        ...persistentHeaders,
        "business-unit": data.context.session.BotUserSession.businessUnit,
      },
      timeout: 30000,
      data, // keep session context for circuit breaker
    });

    // âœ… success path
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
    return triggerAgentTransfer(
      data,
      callback,
      "Please hold while I transfer you to an agent."
    );
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
      headers: { "Content-Type": "application/json", "X-Correlation-Id": cid },
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
      await Promise.resolve(
        circuitBreaker.recordFailure("easysystem-save-api", saveError)
      );
    } catch (_) {}
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

  const customData = s.BotUserSession?.customData || {};
  const USER_ID = customData.userid || null;
  const MASTER_ACCOUNT = customData.master || null;

  if (USER_ID === null || MASTER_ACCOUNT === null) {
    enhancedLogger.warn("Missing critical session data", {
      conversationId: convId,
      missingFields: { USER_ID, MASTER_ACCOUNT },
    });
  }

  const isLoggedIn = String(
    Boolean(
      pickFirst(
        s.BotUserSession?.isLoggedIn,
        s.UserSession.isLoggedIn,
        s.BotUserSession?.userProfile?.isLoggedIn,
        customData.loggedIn
      )
    )
  );

  return {
    headers: {
      "Content-Type": "application/json",
      "business-unit": bu,
      isLoggedIn: isLoggedIn,
      "x-custom-data": JSON.stringify({
  USER_ID,
  MASTER_ACCOUNT,
})

    },
    body: {
      externalConversationId: convId,
      conversationId: convId,
      assistantType: "STANDARD",
      entityMap: {
        USER_ID,
        MASTER_ACCOUNT,
      },
      loggedIn: isLoggedIn,
      channel: "Kore",
    },
  };
}

function easyHeaders(data) {
  const customData = data.context?.session?.BotUserSession?.customData || {};
  const isLoggedIn = customData.loggedIn ? "true" : "false";

  const USER_ID = customData.userid || null;
  const MASTER_ACCOUNT = customData.master || null;

  if (USER_ID === null || MASTER_ACCOUNT === null) {
    enhancedLogger.warn("Missing critical header data", {
      missingFields: { USER_ID, MASTER_ACCOUNT },
    });
  }

  // Only send minimal user context (not full customData)
  return {
    "Content-Type": "application/json",
    "business-unit": buOf(data),
    isLoggedIn,
    "x-custom-data": JSON.stringify({
      USER_ID,
      MASTER_ACCOUNT,
    }),
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

    const s = data.context?.session || {};
    const bu = s.BotUserSession?.businessUnit || "SA";
    const convId = s.BotUserSession?.conversationSessionId;
    const customData = s.BotUserSession?.customData || {};

    const USER_ID = customData.userid || null;
    const MASTER_ACCOUNT = customData.master || null;
    const isLoggedIn = String(
      Boolean(
        s.BotUserSession?.isLoggedIn ||
          s.UserSession?.isLoggedIn ||
          customData.loggedIn
      )
    );

    const contextPayload = {
      externalConversationId: convId,
      assistantType: "STANDARD",
      context: [],
      entityMap: { USER_ID, MASTER_ACCOUNT },
      loggedIn: isLoggedIn,
      channel: "Kore",
    };

    const headers = {
  "Content-Type": "application/json",
  "business-unit": bu,
  isLoggedIn: isLoggedIn,
  "x-custom-data": JSON.stringify({
    USER_ID,
    MASTER_ACCOUNT,
  }),
};


    console.log(
      "Ã°Å¸Å¸Â¢ Sending context to EasySystem with payload:",
      JSON.stringify(contextPayload, null, 2)
    );

    enhancedLogger.logApiCallStart(contextUrl, contextPayload, correlationId);

    const res = await apiClient.post(contextUrl, contextPayload, {
      headers,
      timeout: 30000,
      data,
    });

    await Promise.resolve(
      circuitBreaker.recordSuccess("easysystem-context-api", data)
    );
    enhancedLogger.logApiCallComplete(contextUrl, res, correlationId);
  } catch (err) {
    await Promise.resolve(
      circuitBreaker.recordFailure("easysystem-context-api", data, err)
    );
    enhancedLogger.logApiCallError(contextUrl, err, correlationId);
  }
}

async function easySendText(data, text) {
  const correlationId = enhancedLogger.generateCorrelationId();
  const payload = {
    text,
    externalConversationId:
      data.context.session.BotUserSession.conversationSessionId,
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
  data.message = responseData?.text || "";
  const handoffMsg =
    responseData?.text || "Please hold while I transfer you to an agent.";

  if (responseData?.transfer) {
    data.context.session.BotUserSession.transfer = true;
    if (data._via_webhook) {
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
        !data.context.session.BotUserSession.businessUnit?.toString().trim()
      ) {
        return sdk.sendBotMessage(data, callback);
      }

      if (!data.message || !data.message.trim()) {
        return sdk.sendBotMessage(data, callback);
      }

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

        safeMessageSave(
          easysytemSaveMessageUrl,
          messageSaveData,
          data,
          correlationId
        );

        safeEasySystemCall(
          "easysystem-send-api",
          easysytemUrl,
          requestData,
          data,
          callback,
          correlationId,
          (response, data, callback) => {
            data.message = response.data.text;
            if (!!response.data.conversationEnd) {
              data.context.session.UserSession.owner = "kore";
            }
            sdk.sendUserMessage(data, callback);
          }
        ).catch(() =>
          triggerAgentTransfer(
            data,
            callback,
            "Please hold while I transfer you to an agent."
          )
        );
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
            correlationId
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
        !data.context.session.BotUserSession.businessUnit?.toString().trim()
      ) {
        return sdk.sendUserMessage(data, callback);
      }

      if (!data.message || !data.message.trim()) {
        return sdk.sendUserMessage(data, callback);
      }

      const messageSaveData = {
        text: data.message,
        externalConversationId:
          data.context.session.BotUserSession.conversationSessionId,
        businessUnit: data.context.session.BotUserSession.businessUnit,
        role: "assistant",
        channel: "Kore",
      };

      if (session_owner === "easysystem") {
        // respect owner; do not save duplicate
      } else {
        safeMessageSave(
          easysytemSaveMessageUrl,
          messageSaveData,
          data,
          correlationId
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
      console.log("Webhook component:", componentName);

      const contextData = {
        externalConversationId:
          data.context.session.BotUserSession.conversationSessionId,
        conversationId:
          data.context.session.BotUserSession.conversationSessionId,
        assistantType: "STANDARD",
        channel: "Kore",
      };

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
        easySystemHook: "package_tracking_handover",
      };

      const integrationMethod = webhookMap[componentName];

      if (!integrationMethod || typeof integrations[integrationMethod] !== "function") {
        return sdk.sendWebhookResponse(data, callback);
      }

      const customData = data.context?.session?.BotUserSession?.customData || {};
      contextData.entityMap = {
        USER_ID: customData.userid || null,
        MASTER_ACCOUNT: customData.master || null,
      };

      console.log(`Updating EasySystem context for ${componentName}`);

      return safeEasySystemCall(
        "easysystem-context-api",
        contextUrl,
        contextData,
        data,
        callback,
        correlationId,
        (response, data, callback) => {
          console.log(`Context updated for ${componentName}`);
          return integrations[integrationMethod](data, callback);
        }
      );
    } catch (error) {
      enhancedLogger.error(
        "WEBHOOK_PROCESSING_ERROR",
        {
          error: error.message,
          componentName,
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
// Integrations (Base SBA)
// =============================

const integrations = {
  // === SBA: SCRIPT MODE integrations ===
  package_tracking_handover: function (data, callback) {
    const orderNumber = data.context.orderNumber;
    const zipCode = data.context.zipCode;
    const text = `can you help me track my order? My order number is ${orderNumber} and zip code is ${zipCode}`;

    const requestData = {
      text,
      externalConversationId:
        data.context.session.BotUserSession.conversationSessionId,
      conversationId:
        data.context.session.BotUserSession.conversationSessionId,
      businessUnit: data.context.session.BotUserSession.businessUnit,
    };

    apiClient
      .post(easysytemUrl, requestData, {
        headers: { ...easyHeaders(data) },
        timeout: 30000,
        data,
      })
      .then((response) => {
        data.context.session.BotUserSession.trackOrder = response.data.text;
        data.context.session.BotUserSession.content = response.data.contentType;

        if (response.data.transfer) {
          data.context.session.BotUserSession.transfer = response.data.transfer;
          data.context.session.UserSession.owner = "kore";
          data.agent_transfer = true;
          return sdk.sendBotMessage(data, callback);
        } else if (response.data.endConversation) {
          data.context.session.BotUserSession.endConversationFromEasySystem =
            response.data.endConversation;
          data.context.session.UserSession.owner = "kore";
        } else {
          data.context.session.UserSession.owner = "kore";
        }

        return callback(null, data);
      })
      .catch(() =>
        triggerAgentTransfer(
          data,
          callback,
          "Please hold while I transfer you to an agent."
        )
      );
  },

  Check_Return: function (data, callback) {
    const orderNumber = data.context.orderNumber;
    const zipCode = data.context.zipCode;
    const text = `Check the status for Return an order with order number ${orderNumber} and ZipCode ${zipCode}`;

    const requestData = {
      text,
      externalConversationId:
        data.context.session.BotUserSession.conversationSessionId,
      conversationId:
        data.context.session.BotUserSession.conversationSessionId,
      businessUnit: data.context.session.BotUserSession.businessUnit,
    };

    apiClient
      .post(easysytemUrl, requestData, {
        headers: { ...easyHeaders(data) },
        timeout: 30000,
        data,
      })
      .then((response) => {
        data.context.session.BotUserSession.returnStatus = response.data.text;
        data.context.session.BotUserSession.content = response.data.contentType;

        if (response.data.transfer) {
          data.context.session.BotUserSession.transfer = response.data.transfer;
          data.context.session.UserSession.owner = "kore";
          data.agent_transfer = true;
          return sdk.sendBotMessage(data, callback);
        } else if (response.data.endConversation) {
          data.context.session.BotUserSession.endConversationFromEasySystem =
            response.data.endConversation;
          data.context.session.UserSession.owner = "kore";
        } else {
          data.context.session.UserSession.owner = "kore";
        }

        return callback(null, data);
      })
      .catch(() =>
        triggerAgentTransfer(
          data,
          callback,
          "Please hold while I transfer you to an agent."
        )
      );
  },

  // === SBA: DIRECT-SEND integrations ===
  Cancel_item: function (data, callback) {
    const orderNumber = data.context.orderNumberForCancelItem;
    const zipCode = data.context.zipcodeForCancelItem;
    const text = `Cancel Item having Order Number ${orderNumber} and ZipCode ${zipCode}`;
    easySendText(data, text)
      .then((res) =>
        handleEasySendOutcome_Direct("Cancel Item", data, res, callback)
      )
      .catch((err) =>
        handleEasySendError_Direct("Cancel Item", data, err, callback)
      );
  },

  add_new_user_handler: function (data, callback) {
    const text = "I want to add a new user to my Staples account.";
    easySendText(data, text)
      .then((res) =>
        handleEasySendOutcome_Direct("Add New User", data, res, callback)
      )
      .catch((err) =>
        handleEasySendError_Direct("Add New User", data, err, callback)
      );
  },

  Cancel_Entire_order: function (data, callback) {
    const orderNumber = data.context.orderNumberForCancelOrder;
    const zipCode = data.context.zipcodeForCancelOrder;
    const text = `Cancel the Entire Order having Order Number ${orderNumber} and ZipCode ${zipCode}`;
    easySendText(data, text)
      .then((res) =>
        handleEasySendOutcome_Direct("Cancel Entire Order", data, res, callback)
      )
      .catch((err) =>
        handleEasySendError_Direct("Cancel Entire Order", data, err, callback)
      );
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
      .then((res) =>
        handleEasySendOutcome_Direct("Exchange", data, res, callback)
      )
      .catch((err) =>
        handleEasySendError_Direct("Exchange", data, err, callback)
      );
  },

  change_shipping_address: function (data, callback) {
    const text =
      "I want to add a new shipping location to my Staples account (enter address, set delivery preferences, and update contact details).";
    easySendText(data, text)
      .then((res) =>
        handleEasySendOutcome_Direct("Shipping Address", data, res, callback)
      )
      .catch((err) =>
        handleEasySendError_Direct("Shipping Address", data, err, callback)
      );
  },

  manage_existing_users: function (data, callback) {
    const text =
      "I want to manage an existing user on my Staples account (edit details, change roles/permissions, or deactivate).";
    easySendText(data, text)
      .then((res) =>
        handleEasySendOutcome_Direct("Manage Existing User", data, res, callback)
      )
      .catch((err) =>
        handleEasySendError_Direct("Manage Existing User", data, err, callback)
      );
  },

  reset_password: function (data, callback) {
    const text = "Reset the password";
    easySendText(data, text)
      .then((res) =>
        handleEasySendOutcome_Direct("Reset Password", data, res, callback)
      )
      .catch((err) =>
        handleEasySendError_Direct("Reset Password", data, err, callback)
      );
  },

  reset_password_handler: function (data, callback) {
    const text = "Reset the password";
    easySendText(data, text)
      .then((res) =>
        handleEasySendOutcome_Direct("Reset Password Hook", data, res, callback)
      )
      .catch((err) => handleEasySendError_Direct("Reset Hook", data, err, callback));
  },

  invoice_or_packing_slip: function (data, callback) {
    const text = "I need help with an invoice or packing slip.";
    easySendText(data, text)
      .then((res) => handleEasySendOutcome_Direct("Invoice", data, res, callback))
      .catch((err) => handleEasySendError_Direct("Invoice", data, err, callback));
  },

  modify_shipping_location: function (data, callback) {
    const text =
      "I want to modify an existing shipping location on my Staples account";
    easySendText(data, text)
      .then((res) =>
        handleEasySendOutcome_Direct("Modify Shipping", data, res, callback)
      )
      .catch((err) =>
        handleEasySendError_Direct("Modify Shipping", data, err, callback)
      );
  },

  account_id_handler: function (data, callback) {
    const text = "I need help with my account or user ID.";
    easySendText(data, text)
      .then((res) =>
        handleEasySendOutcome_Direct("Account ID", data, res, callback)
      )
      .catch((err) =>
        handleEasySendError_Direct("Account ID", data, err, callback)
      );
  },

  missing_item: function (data, callback) {
    const text = "I'm missing an item from my order.";
    easySendText(data, text)
      .then((res) =>
        handleEasySendOutcome_Direct("Missing Item", data, res, callback)
      )
      .catch((err) =>
        handleEasySendError_Direct("Missing Item", data, err, callback)
      );
  },
};

// Support consumers that import default export
try {
  module.exports.default = module.exports;
} catch (_) {}