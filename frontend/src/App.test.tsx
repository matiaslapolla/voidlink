import { render, screen } from "@testing-library/react";
import { describe, it, expect, vi } from "vitest";
import App from "./App";

vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(),
}));

describe("App", () => {
  it("renders empty state when no pages exist", () => {
    localStorage.clear();
    render(<App />);
    expect(screen.getByText("No page selected")).toBeInTheDocument();
  });

  it("renders the new page button", () => {
    localStorage.clear();
    render(<App />);
    expect(
      screen.getByRole("button", { name: /new page/i }),
    ).toBeInTheDocument();
  });
});
