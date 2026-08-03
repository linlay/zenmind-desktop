export function decodeRoutePathSegment(
  value: string | null | undefined
): string | null {
  const encodedValue = value?.trim() ?? "";
  if (!encodedValue) {
    return null;
  }

  try {
    const decodedValue = decodeURIComponent(encodedValue).trim();
    return decodedValue || null;
  } catch {
    return null;
  }
}

export function encodeRoutePathSegment(value: string): string {
  return encodeURIComponent(value.trim());
}
