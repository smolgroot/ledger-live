import test from "../../fixtures/common";
import { expect } from "@playwright/test";
import { PortfolioPage } from "../../models/PortfolioPage";
import { AddAccountModal } from "../../models/AddAccountModal";
import { DeviceAction } from "../../models/DeviceAction";
import { Layout } from "../../models/Layout";
import { AccountsPage } from "../../models/AccountsPage";

test.use({ userdata: "skip-onboarding" });

const currencies = ["BTC", "LTC", "ETH", "ATOM", "XTZ", "XRP"];

test.describe.parallel("Accounts", () => {
  for (const currency of currencies) {
    let firstAccountName = "NO ACCOUNT NAME YET";

    test(`[${currency}] Add account`, async ({ page }) => {
      const portfolioPage = new PortfolioPage(page);
      const addAccountModal = new AddAccountModal(page);
      const deviceAction = new DeviceAction(page);
      const layout = new Layout(page);
      const accountsPage = new AccountsPage(page);

      await test.step(`[${currency}] Open modal`, async () => {
        await portfolioPage.openAddAccountModal();
        expect(await addAccountModal.title.textContent()).toBe("Add accounts");
        await expect.soft(addAccountModal.container).toHaveScreenshot(`open-modal.png`);
      });

      await test.step(`[${currency}] Select currency`, async () => {
        await addAccountModal.select(currency);
        await expect.soft(addAccountModal.container).toHaveScreenshot(`${currency}-select.png`);
        await addAccountModal.continue();
      });

      await test.step(`[${currency}] Open device app`, async () => {
        await deviceAction.openApp();
        await addAccountModal.waitForSync();
        const name = await addAccountModal.getFirstAccountName();
        if (typeof name === "string") {
          firstAccountName = name;
        }
        await expect
          .soft(addAccountModal.container)
          .toHaveScreenshot(`${currency}-accounts-list.png`);
      });

      await test.step(`[${currency}] Scan and add accounts`, async () => {
        await addAccountModal.addAccounts();
        await expect.soft(addAccountModal.container).toHaveScreenshot(`${currency}-success.png`);
      });

      await test.step(`[${currency}] Done`, async () => {
        await addAccountModal.done();
        await layout.totalBalance.waitFor({ state: "visible" });
        await expect
          .soft(page)
          .toHaveScreenshot(`${currency}-complete.png`, { mask: [page.locator("canvas")] });
      });

      await test.step(`Navigate to first account`, async () => {
        await layout.goToAccounts();
        await accountsPage.navigateToAccountByName(firstAccountName);
        await expect.soft(page).toHaveScreenshot(`${currency}-firstAccountPage.png`);
      });
    });
  }
});
