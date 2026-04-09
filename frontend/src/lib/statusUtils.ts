export function isTerminalStatus(status: string): boolean {
  return status === "success" || status === "failed";
}
