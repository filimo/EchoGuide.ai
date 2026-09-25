// @vitest-environment jsdom
import { afterEach, expect, it } from "vitest";
import { installHoverHints } from "./hoverHints";

const root = document.createElement("div");
document.body.append(root);
afterEach(() => { root.replaceChildren(); });

it("adds hover help to buttons and changing statuses without replacing specific hints", async () => {
  root.innerHTML = '<button>Sessions</button><button title="Specific action">Notes</button><span class="status">Realtime: disconnected</span>';
  const stop = installHoverHints(root);
  const buttons = root.querySelectorAll("button");
  const status = root.querySelector(".status")!;
  expect(buttons[0].getAttribute("title")).toContain("сохранённые сессии");
  expect(buttons[1].getAttribute("title")).toBe("Specific action");
  expect(status.getAttribute("title")).toContain("disconnected");
  status.textContent = "Realtime: connected";
  await Promise.resolve();
  expect(status.getAttribute("title")).toContain("connected");
  const added = document.createElement("button");
  added.setAttribute("aria-label", "Новый вариант");
  root.append(added);
  await Promise.resolve();
  expect(added.getAttribute("title")).toBe("Кнопка: Новый вариант");
  stop();
});
