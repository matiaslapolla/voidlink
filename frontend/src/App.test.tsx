import { render, screen } from "@solidjs/testing-library";
import { describe, it, expect, vi } from "vitest";
import App from "./App";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: vi.fn(() => ({
    clearEffects: vi.fn().mockResolvedValue(undefined),
    setEffects: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn().mockResolvedValue(() => {}),
}));

describe("App", () => {
  it("renders empty workspace state when no tabs exist", () => {
    localStorage.clear();
    render(() => <App />);
    expect(screen.getByText("Empty workspace")).toBeInTheDocument();
  });

  it("renders new workspace buttons", () => {
    localStorage.clear();
    render(() => <App />);
    expect(
      screen.getAllByRole("button", { name: /new workspace/i }).length,
    ).toBeGreaterThan(0);
  });
});
