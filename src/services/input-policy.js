const textInputTypes = new Set(["text", "password"]);

export function blockCursorOffset(inputRect, promptRect, textWidth, scrollLeft) {
  return inputRect.left - promptRect.left + textWidth - scrollLeft;
}

export function insertionPoint(input) {
  const start = input.selectionStart ?? input.value.length;
  const end = input.selectionEnd ?? start;
  return input.selectionDirection === "backward" ? start : end;
}

export function isAllowedTextInput(target) {
  const isTextInput = target?.tagName === "INPUT" && textInputTypes.has(target.type);
  const isTextArea = target?.tagName === "TEXTAREA";
  return (isTextInput || isTextArea) &&
    target.dataset?.chatInput === "true" &&
    !target.disabled &&
    !target.readOnly;
}

export function isAllowedFocusTarget(target) {
  if (isAllowedTextInput(target)) return true;
  if (target?.tagName === "BUTTON") return !target.disabled;
  return target?.tagName === "A" && Boolean(target.href);
}
