import type { Page } from "playwright";

export async function openHistoryMenu(page: Page, name: string) {
  const english = (await page.locator("html").getAttribute("lang")) === "en";
  const trigger = page.getByRole("button", {
    name: english ? `More actions for ${name}` : `更多操作 ${name}`,
    exact: true,
  });
  await page.locator("[data-history-id]").filter({ has: trigger }).hover();
  await trigger.click();
  const menu = page.getByRole("menu");
  await menu.waitFor();
  return menu;
}

export async function chooseHistoryAction(
  page: Page,
  name: string,
  action: "rename" | "delete",
) {
  const english = (await page.locator("html").getAttribute("lang")) === "en";
  const labels = english
    ? { rename: "Rename", delete: "Delete" }
    : { rename: "修改名称", delete: "删除" };
  const menu = await openHistoryMenu(page, name);
  await menu
    .getByRole("menuitem", { name: labels[action], exact: true })
    .click();
}
