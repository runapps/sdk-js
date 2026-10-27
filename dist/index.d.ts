/**
 * RunApps SDK for JavaScript / TypeScript.
 *
 * Top-level entry point — exports the `RunApps` client class plus all
 * public types so callers can write strongly-typed wrappers without
 * reaching into per-service modules.
 */
export { RunApps, RunApps as Client, RunApps as RunJobs, type ClientOptions, type AuthProvider } from "./client.js";
export { SDKEvents, newRequestId, type RequestStartEvent, type RequestStreamDeltaEvent, type RequestEndEvent, type RequestErrorEvent, type SDKEventMap, type SDKCapability, type Unsubscribe, } from "./events.js";
export { ActivityTracker, type ActiveCall, type CompletedCall, type SessionStats, type ActivitySnapshot, } from "./activity-tracker.js";
export { BrowserAuth, type BrowserAuthOptions, type BrowserUser } from "./browser-auth.js";
export { AppsService, encodeHandoff, decodeHandoff, parseHandoffPayload, parseResultPayload, appSlugOf, appOriginFrom, isAppOrigin, isFilesURL, type HandoffAction, type HandoffFile, type HandoffSource, type HandoffResult, type HandoffPayload, type ResultPayload, type IncomingHandoff, type ReceiverApp, type SendOptions, } from "./apps.js";
export { SyncEngine, FilesRemote, installIndexedDBHook, type SyncOptions, type SyncState, type DbChange, type SyncRemote, type SyncDeps, } from "./sync/index.js";
export type { SyncStateEvent, DbChangeEvent } from "./events.js";
export { APIError } from "./errors.js";
export type { Usage } from "./types.js";
export type { ChatMessage, ContentPart, ChatTool, ChatResponseFormat, StreamOptions, ChatCompletionParams, ChatToolCall, ChatChoiceMessage, ChatChoice, ChatCompletion, ChatChunkDelta, ChatChunkChoice, ChatCompletionChunk, PromptRef, PromptInput, } from "./chat.js";
export { userMessage, systemMessage, assistantMessage, toolResultMessage, userMessageParts, textPart, imagePart, videoPart, audioPart, } from "./chat.js";
export type { Model, ModelListOptions, Tag } from "./models.js";
export { hasCapabilityTag, acceptsModality, supportsVoiceClone, supportsInstructText, defaultVoice, defaultModel, } from "./models.js";
export type { Schema, FieldSchema, Constraint, ConstraintKind, Catalog, } from "./model_options.js";
export { getOptionsSchema, acceptsField, requiresField, allowedValuesFor, } from "./model_options.js";
export type { ValidationError } from "./validate.js";
export { validateRequest } from "./validate.js";
export type { ImageGenerateParams, ImageResult, ImageUsage, ImageResponse, ImageEditParams, ImageFileInput, AsyncImageJob, } from "./image.js";
export type { SpeechParams, SpeechResponse, TranscribeParams, TranscribeResponse, AudioFileInput, } from "./audio.js";
export type { RealtimeEvent, RealtimeUsage, RealtimeCloseInfo, RealtimeConnectOptions, WebSocketLike, WebSocketConstructor, } from "./realtime.js";
export { RealtimeSession, pcm16FromFloat32, float32FromPCM16, bytesToBase64, base64ToBytes, } from "./realtime.js";
export type { VideoGenerateParams, VideoTask, VideoStatus, VideoUsageTokens, WaitOptions, } from "./video.js";
export type { Quote } from "./quote.js";
export type { Me } from "./client.js";
export type { AssetVerifyResult } from "./assets.js";
export { AssetsService } from "./assets.js";
export { encodeImageUrl, decodeMediaUrl } from "./media.js";
export type { FileObject, FileListResult, PutOptions as FilePutOptions, SignOptions as FileSignOptions, ListOptions as FileListOptions, PutFromURLOptions as FilePutFromURLOptions, BatchOp as FileBatchOp, BatchResult as FileBatchResult, } from "./files.js";
export type { EmbeddingsParams, Embedding, EmbeddingsUsage, EmbeddingsResponse, } from "./embeddings.js";
export { ServerTools, type ServerToolName } from "./chat.js";
//# sourceMappingURL=index.d.ts.map