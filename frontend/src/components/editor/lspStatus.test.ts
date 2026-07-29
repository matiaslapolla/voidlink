import { describe, expect, it } from "vitest";
import { NO_LSP, lspSegment, nextStatus, shouldToastCrash, type LspStatus } from "./lspStatus";

const at = (state: LspStatus["state"], crashes = 0): LspStatus => ({
  state,
  server: "rust-analyzer",
  crashes,
});

describe("lspSegment", () => {
  /// The whole point of the `absent` state: a user with no language server
  /// installed sees nothing, not a permanent grey warning chip.
  it("renders nothing when there is no server", () => {
    expect(lspSegment(NO_LSP)).toBeNull();
  });

  it("names the server in every visible state", () => {
    expect(lspSegment(at("starting"))?.text).toBe("rust-analyzer starting");
    expect(lspSegment(at("ready"))?.text).toBe("rust-analyzer");
    expect(lspSegment(at("degraded"))?.text).toBe("rust-analyzer degraded");
    expect(lspSegment(at("crashed"))?.text).toBe("rust-analyzer stopped");
  });

  /// MASTER §7.5.3 rule 4 / §10.9. `starting` and `degraded` are both
  /// `--warning`; `prefers-reduced-motion` removes the pulse, so if motion
  /// were the only difference they would be the same pixels. The hollow
  /// pending form is the second channel.
  it("separates starting from degraded without relying on motion", () => {
    const starting = lspSegment(at("starting"))!;
    const degraded = lspSegment(at("degraded"))!;
    expect(starting.pending).toBe(true);
    expect(degraded.pending).toBe(false);
    expect(starting.signal).not.toBe(degraded.signal);
  });

  it("offers a restart only for a crash", () => {
    expect(lspSegment(at("crashed"))?.action).toBe("restart");
    expect(lspSegment(at("ready"))?.action).toBe("log");
    expect(lspSegment(at("degraded"))?.action).toBe("log");
    expect(lspSegment(at("starting"))?.action).toBe("log");
  });

  it("uses the failure signal only for a crash", () => {
    expect(lspSegment(at("crashed"))?.signal).toBe("failed");
    expect(lspSegment(at("ready"))?.signal).toBe("finished");
  });
});

describe("nextStatus", () => {
  it("counts consecutive crashes", () => {
    let s = NO_LSP;
    s = nextStatus(s, { state: "starting", server: "rust-analyzer" });
    s = nextStatus(s, { state: "crashed" });
    s = nextStatus(s, { state: "starting" });
    s = nextStatus(s, { state: "crashed" });
    expect(s.crashes).toBe(2);
  });

  /// Three crashes with a working start between them is not a crash loop, and
  /// toasting for it would be the "toast on every crash-restart cycle" the
  /// design forbids.
  it("resets the counter once the server actually comes up", () => {
    let s = at("crashed", 2);
    s = nextStatus(s, { state: "ready" });
    expect(s.crashes).toBe(0);
    s = nextStatus(s, { state: "crashed" });
    expect(s.crashes).toBe(1);
  });

  it("forgets everything when the server goes away", () => {
    expect(nextStatus(at("crashed", 5), { state: "absent" })).toEqual(NO_LSP);
  });

  it("keeps the server name across transitions that omit it", () => {
    expect(nextStatus(at("ready"), { state: "degraded" }).server).toBe("rust-analyzer");
  });
});

describe("shouldToastCrash", () => {
  it("fires exactly once, at the third consecutive crash", () => {
    expect(shouldToastCrash(at("crashed", 1))).toBe(false);
    expect(shouldToastCrash(at("crashed", 2))).toBe(false);
    expect(shouldToastCrash(at("crashed", 3))).toBe(true);
    expect(shouldToastCrash(at("crashed", 4))).toBe(false);
  });

  it("never fires for a state that is not a crash", () => {
    expect(shouldToastCrash(at("ready", 3))).toBe(false);
  });
});
