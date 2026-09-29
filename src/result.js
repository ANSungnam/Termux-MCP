export function text(value) {
  return { content: [{ type: 'text', text: String(value ?? '') }] };
}

export function json(value) {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

export function errorResult(message) {
  return { isError: true, content: [{ type: 'text', text: String(message) }] };
}

export function imageResult(base64, mimeType) {
  return { content: [{ type: 'image', data: base64, mimeType }] };
}

export function describeError(error) {
  if (error?.name === 'ConfirmationRequired') return error.message;
  if (error?.name === 'PathRefused') return error.message;
  return `${error?.name ?? 'Error'}: ${error?.message ?? String(error)}`;
}
