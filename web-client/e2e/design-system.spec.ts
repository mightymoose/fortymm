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
});
