const EXACT_COMMANDS = new Set(["wake", "sleep", "steam_on", "steam_off"]);

export function parseCommand(text) {
  if (typeof text !== "string") return null;
  const trimmed = text.trim();
  if (trimmed === "") return null;
  if (EXACT_COMMANDS.has(trimmed)) {
    return { kind: trimmed, argument: null };
  }
  if (text.startsWith("profile_filename ")) {
    const argument = text.slice("profile_filename ".length);
    if (argument.trim() === "") return null;
    return { kind: "profile_filename", argument };
  }
  if (text.startsWith("profile ")) {
    const argument = text.slice("profile ".length);
    if (argument.trim() === "") return null;
    return { kind: "profile", argument };
  }
  return null;
}
