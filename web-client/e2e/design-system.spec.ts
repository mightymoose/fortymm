import { test, expect } from '@playwright/test';
import { DesignSystemPage } from './page-objects/design-system.page';

test.describe('Design System', () => {
  test('should style the buttons correctly', async ({ page }) => {
    const designSystemPage = await DesignSystemPage.navigateTo(page);

    await expect(designSystemPage.buttonShowcase.primaryButton).toHaveScreenshot('plain-button.png');
    await expect(designSystemPage.buttonShowcase.secondaryButton).toHaveScreenshot('secondary-button.png');
    await expect(designSystemPage.buttonShowcase.outlineButton).toHaveScreenshot('outline-button.png');
    await expect(designSystemPage.buttonShowcase.ghostButton).toHaveScreenshot('ghost-button.png');
    await expect(designSystemPage.buttonShowcase.destructiveButton).toHaveScreenshot('destructive-button.png');
    await expect(designSystemPage.buttonShowcase.linkButton).toHaveScreenshot('link-button.png');
    await expect(designSystemPage.buttonShowcase.disabledButton).toHaveScreenshot('disabled-button.png');
    await expect(designSystemPage.buttonShowcase.smallButton).toHaveScreenshot('small-button.png');
    await expect(designSystemPage.buttonShowcase.defaultButton).toHaveScreenshot('default-button.png');
    await expect(designSystemPage.buttonShowcase.largeButton).toHaveScreenshot('large-button.png');
    await expect(designSystemPage.buttonShowcase.iconButton).toHaveScreenshot('icon-button.png');
  });

  test('should style the inputs correctly', async ({ page }) => {
    const designSystemPage = await DesignSystemPage.navigateTo(page);

    await expect(designSystemPage.inputShowcase.playerTagInput).toHaveScreenshot('player-tag-input.png');
    await expect(designSystemPage.inputShowcase.emailInput).toHaveScreenshot('email-input.png');
    await expect(designSystemPage.inputShowcase.disabledInput).toHaveScreenshot('disabled-input.png');
    await expect(designSystemPage.inputShowcase.searchInput).toHaveScreenshot('search-input.png');
  });

  test('should style the dialog correctly', async ({ page }) => {
    const designSystemPage = await DesignSystemPage.navigateTo(page);

    const dialog = await designSystemPage.overlayShowcase.openDialog();
    await expect(dialog).toHaveScreenshot('dialog.png');
  });

  test('should style the alert dialog correctly', async ({ page }) => {
    const designSystemPage = await DesignSystemPage.navigateTo(page);

    const alertDialog = await designSystemPage.overlayShowcase.openAlertDialog();
    await expect(alertDialog).toHaveScreenshot('alert-dialog.png');
  });

  test('should style the sheet correctly', async ({ page }) => {
    const designSystemPage = await DesignSystemPage.navigateTo(page);

    const sheet = await designSystemPage.sheetShowcase.openSheet();
    await expect(sheet).toHaveScreenshot('sheet.png');
  });

  test('should style the toasts correctly', async ({ page }) => {
    const designSystemPage = await DesignSystemPage.navigateTo(page);

    await expect(designSystemPage.feedbackShowcase.successToast).toHaveScreenshot('toast-success.png');
    await expect(designSystemPage.feedbackShowcase.errorToast).toHaveScreenshot('toast-error.png');
    await expect(designSystemPage.feedbackShowcase.infoToast).toHaveScreenshot('toast-info.png');
  });
});
