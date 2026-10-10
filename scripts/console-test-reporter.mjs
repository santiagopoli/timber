import {isAbsolute, relative} from 'node:path';
import {stripVTControlCharacters} from 'node:util';

// Keep annotations small and single-line. Never inspect arbitrary error objects,
// assertion actual/expected values, environment variables, or captured output.
const truncation = '… [truncated]';
function escape(value, limit, property = false) {
  const text = stripVTControlCharacters(value).replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
  let result = '';
  for (const char of text) {
    const encoded = char === '%' ? '%25' : char === '\r' ? '%0D' : char === '\n' ? '%0A'
      : property && char === ',' ? '%2C' : property && char === ':' ? '%3A' : char;
    if (result.length + encoded.length > limit - truncation.length) return result + truncation;
    result += encoded;
  }
  return result;
}

function annotation(data) {
  const error = data.details?.error;
  // Parent summaries would duplicate the actionable child failure. Failed TODOs
  // do not fail node:test either, so they must not create CI error annotations.
  if (error?.failureType === 'subtestsFailed' || data.todo) return;
  const cause = error?.cause;
  const diagnostic = cause && typeof cause === 'object' ? cause : error;
  const name = typeof data.name === 'string' ? data.name : 'Unnamed test';
  const detail = typeof diagnostic?.stack === 'string' ? diagnostic.stack
    : typeof diagnostic?.message === 'string' ? diagnostic.message
      : typeof cause === 'string' ? cause : 'Test failed (no assertion detail provided)';
  const properties = [];
  if (typeof data.file === 'string' && data.file) {
    const file = isAbsolute(data.file) ? relative(process.cwd(), data.file) : data.file;
    properties.push(`file=${escape(file, 1024, true)}`);
    if (Number.isSafeInteger(data.line) && data.line > 0) properties.push(`line=${data.line}`);
    if (Number.isSafeInteger(data.column) && data.column > 0) properties.push(`col=${data.column}`);
  }
  const message = escape(`${name.slice(0, 512)}\n${detail.split('\n').slice(0, 12).join('\n')}`, 6000);
  return `::error${properties.length ? ` ${properties.join(',')}` : ''}::${message}\n`;
}

// Used alongside Node's spec reporter, not instead of it. Consume the stream
// outside Actions too, while leaving human output and node:test exit status alone.
export default async function* consoleTestReporter(source) {
  const enabled = process.env.GITHUB_ACTIONS === 'true';
  for await (const event of source) {
    if (!enabled || event.type !== 'test:fail') continue;
    const output = annotation(event.data);
    if (output) yield output;
  }
}
