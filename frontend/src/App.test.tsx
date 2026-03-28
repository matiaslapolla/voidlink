import { render, screen } from "@solidjs/testing-library";
import { describe, it, expect, vi } from "vitest";
import App from "./App";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn().mockResolvedValue(null),
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: vi.fn(() => ({
    clearEffects: vi.fn().mockResolvedValue(undefined),
    setEffects: vi.fn().mockResolvedValue(undefined),
  })),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: vi.fn().mockResolvedValue(null),
}));

describe("App", () => {
  it("renders migration workspace shell", () => {
    localStorage.clear();
    render(() => <App />);
    expect(screen.getByText("Workspaces")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /choose repository/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^scan$/i })).toBeInTheDocument();
  });

  it("renders the three migration areas", () => {
    localStorage.clear();
    render(() => <App />);
    expect(screen.getByRole("button", { name: /^repository$/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^context builder$/i })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /^workflow$/i })).toBeInTheDocument();
  });
});
