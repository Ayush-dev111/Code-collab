// Links in pages may only point to http(s), mailto, or paths in this app.
export function safeLinkUrl(input: string): string | undefined {
  try {
    const value = input.trim();
    if (
      !value ||
      [...value].some(
        (character) =>
          character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127,
      ) ||
      value.includes("\\")
    )
      return undefined;
    if (value.startsWith("/") && !value.startsWith("//")) return value;
    const url = new URL(value);
    if (
      !["https:", "http:", "mailto:"].includes(url.protocol) ||
      url.username ||
      url.password
    )
      return undefined;
    return value;
  } catch {
    return undefined;
  }
}
