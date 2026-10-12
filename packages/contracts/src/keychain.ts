/** Public metadata only. Secret values and encrypted envelopes never leave the host. */
export type SecretMetadata = {id:string;name:string;origin:string;header:string;prefix:string;revision:number;createdAt:string;updatedAt:string;lastUsedAt?:string;botIds?:string[]};
export type SecureInputRequest = {id:string;name:string;origin:string;header:string;prefix:string;purpose:string;runId:string;nativeOperationId:string;status:'pending'|'saved'|'cancelled';createdAt:string;secretId?:string;expectedRevision?:number;botId?:string;taskId?:string;permissionEpoch?:string};
