export class RunnerError extends Error {constructor(code,message){super(message);this.name='RunnerError';this.code=code;}}
export function publicError(error){return error instanceof RunnerError?{code:error.code,message:error.message}:{code:'runner_failed',message:'The runner could not complete this operation. Inspect its local status before retrying.'};}
