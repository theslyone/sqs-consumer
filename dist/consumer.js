"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const debug = require("debug")("sqs-consumer");
const SQS = require("aws-sdk/clients/sqs");
const events_1 = require("events");
const bind_1 = require("./bind");
const errors_1 = require("./errors");
const requiredOptions = [
    "queueUrl",
    // only one of handleMessage / handleMessagesBatch is required
    "handleMessage|handleMessagesBatch"
];
function createTimeout(duration) {
    let timeout;
    const pending = new Promise((_, reject) => {
        timeout = setTimeout(() => {
            reject(new errors_1.TimeoutError());
        }, duration);
    });
    return [timeout, pending];
}
function assertOptions(options) {
    requiredOptions.forEach(option => {
        const possibilities = option.split("|");
        if (!possibilities.find(p => options[p])) {
            throw new Error("Missing SQS consumer option [" + possibilities.join(" or ") + "].");
        }
    });
    if (options.batchSize > 10 || options.batchSize < 1) {
        throw new Error("SQS batchSize option must be between 1 and 10.");
    }
}
function isAuthenticationError(err) {
    if (err instanceof errors_1.SQSError) {
        return err.statusCode === 403 || err.code === "CredentialsError";
    }
    return false;
}
function toSQSError(err, message) {
    const sqsError = new errors_1.SQSError(message);
    sqsError.code = err.code;
    sqsError.statusCode = err.statusCode;
    sqsError.region = err.region;
    sqsError.retryable = err.retryable;
    sqsError.hostname = err.hostname;
    sqsError.time = err.time;
    return sqsError;
}
function hasMessages(response) {
    return response.Messages && response.Messages.length > 0;
}
class Consumer extends events_1.EventEmitter {
    constructor(options) {
        super();
        assertOptions(options);
        this.queueUrl = options.queueUrl;
        this.handleMessage = options.handleMessage;
        this.handleMessageBatch = options.handleMessageBatch;
        this.handleMessageTimeout = options.handleMessageTimeout;
        this.attributeNames = options.attributeNames || [];
        this.messageAttributeNames = options.messageAttributeNames || [];
        this.stopped = true;
        this.batchSize = options.batchSize || 1;
        this.visibilityTimeout = options.visibilityTimeout;
        this.terminateVisibilityTimeout =
            options.terminateVisibilityTimeout || false;
        this.waitTimeSeconds = options.waitTimeSeconds || 20;
        this.authenticationErrorTimeout =
            options.authenticationErrorTimeout || 10000;
        this.sqs =
            options.sqs ||
                new SQS({
                    region: options.region || process.env.AWS_REGION || "eu-west-1"
                });
        bind_1.autoBind(this);
    }
    static create(options) {
        return new Consumer(options);
    }
    async start() {
        if (this.stopped) {
            debug("Starting consumer");
            this.stopped = false;
            await this.poll();
        }
    }
    stop() {
        debug("Stopping consumer");
        this.stopped = true;
        this.emit("stopped");
    }
    async handleSqsResponse(response) {
        debug("Received SQS response");
        debug(response);
        if (response) {
            if (hasMessages(response)) {
                if (this.handleMessageBatch) {
                    // prefer handling messages in batch when available
                    this.processMessageBatch(response.Messages);
                }
                else {
                    await Promise.all(response.Messages.map(this.processMessage));
                }
                this.emit("response_processed");
            }
            else {
                this.emit("empty");
            }
        }
        else {
            this.emit("null_response");
        }
        // await this.poll();
    }
    async processMessage(message) {
        this.emit("message_received", message);
        try {
            await this.executeHandler(message);
            await this.deleteMessage(message);
            this.emit("message_processed", message);
        }
        catch (err) {
            this.emitError(err, message);
            if (this.terminateVisibilityTimeout) {
                try {
                    await this.terminateVisabilityTimeout(message);
                }
                catch (err) {
                    this.emit("error", err, message);
                }
            }
        }
    }
    async receiveMessage(params) {
        try {
            return await this.sqs.receiveMessage(params).promise();
        }
        catch (err) {
            throw toSQSError(err, `SQS receive message failed: ${err.message}`);
        }
    }
    async deleteMessage(message) {
        debug("Deleting message %s", message.MessageId);
        const deleteParams = {
            QueueUrl: this.queueUrl,
            ReceiptHandle: message.ReceiptHandle
        };
        try {
            await this.sqs.deleteMessage(deleteParams).promise();
        }
        catch (err) {
            throw toSQSError(err, `SQS delete message failed: ${err.message}`);
        }
    }
    async executeHandler(message) {
        let timeout;
        let pending;
        try {
            if (this.handleMessageTimeout) {
                [timeout, pending] = createTimeout(this.handleMessageTimeout);
                await Promise.race([this.handleMessage(message), pending]);
            }
            else {
                await this.handleMessage(message);
            }
        }
        catch (err) {
            if (err instanceof errors_1.TimeoutError) {
                err.message = `Message handler timed out after ${this.handleMessageTimeout}ms: Operation timed out.`;
            }
            else {
                err.message = `Unexpected message handler failure: ${err.message}`;
            }
            throw err;
        }
        finally {
            clearTimeout(timeout);
        }
    }
    async terminateVisabilityTimeout(message) {
        return this.sqs
            .changeMessageVisibility({
            QueueUrl: this.queueUrl,
            ReceiptHandle: message.ReceiptHandle,
            VisibilityTimeout: 0
        })
            .promise();
    }
    emitError(err, message) {
        if (err.name === errors_1.SQSError.name) {
            this.emit("error", err, message);
        }
        else if (err instanceof errors_1.TimeoutError) {
            this.emit("timeout_error", err, message);
        }
        else {
            this.emit("processing_error", err, message);
        }
    }
    async poll() {
        if (this.stopped) {
            this.emit("stopped");
            return;
        }
        debug("Polling for messages");
        try {
            const receiveParams = {
                QueueUrl: this.queueUrl,
                AttributeNames: this.attributeNames,
                MessageAttributeNames: this.messageAttributeNames,
                MaxNumberOfMessages: this.batchSize,
                WaitTimeSeconds: this.waitTimeSeconds,
                VisibilityTimeout: this.visibilityTimeout
            };
            const response = await this.receiveMessage(receiveParams);
            await this.handleSqsResponse(response);
        }
        catch (err) {
            this.emit("error", err);
            if (isAuthenticationError(err)) {
                debug("There was an authentication error. Pausing before retrying.");
                setTimeout(async () => this.poll(), await this.authenticationErrorTimeout);
            }
        }
    }
    async processMessageBatch(messages) {
        this.emit("batch_message_received", messages);
        messages.forEach(message => {
            this.emit("message_received", message);
        });
        try {
            await this.executeBatchHandler(messages);
            await this.deleteMessageBatch(messages);
            this.emit("batch_message_processed", messages);
            messages.forEach(message => {
                this.emit("message_processed", message);
            });
        }
        catch (err) {
            this.emit("error", err, messages);
            if (this.terminateVisibilityTimeout) {
                try {
                    await this.terminateVisabilityTimeoutBatch(messages);
                }
                catch (err) {
                    this.emit("error", err, messages);
                }
            }
        }
    }
    async deleteMessageBatch(messages) {
        debug("Deleting messages %s", messages.map(msg => msg.MessageId).join(" ,"));
        const deleteParams = {
            QueueUrl: this.queueUrl,
            Entries: messages.map(message => ({
                Id: message.MessageId,
                ReceiptHandle: message.ReceiptHandle
            }))
        };
        try {
            await this.sqs.deleteMessageBatch(deleteParams).promise();
        }
        catch (err) {
            throw toSQSError(err, `SQS delete message failed: ${err.message}`);
        }
    }
    async executeBatchHandler(messages) {
        try {
            await this.handleMessageBatch(messages);
        }
        catch (err) {
            err.message = `Unexpected message handler failure: ${err.message}`;
            throw err;
        }
    }
    async terminateVisabilityTimeoutBatch(messages) {
        const params = {
            QueueUrl: this.queueUrl,
            Entries: messages.map(message => ({
                Id: message.MessageId,
                ReceiptHandle: message.ReceiptHandle,
                VisibilityTimeout: 0
            }))
        };
        return this.sqs.changeMessageVisibilityBatch(params).promise();
    }
}
exports.Consumer = Consumer;
