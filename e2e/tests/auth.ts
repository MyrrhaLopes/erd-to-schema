import { expect, type Page } from '@playwright/test';
import { latestEmail, linkIn, uniqueEmail } from './mail';

export async function signupAndVerify(page: Page, name: string) {
  const email = uniqueEmail(name.toLowerCase());
  await page.goto('/signup');
  await page.getByLabel('Nome').fill(name);
  await page.getByLabel('E-mail').fill(email);
  await page.getByLabel(/Senha/).fill('senha-forte-123');
  await page.getByRole('button', { name: 'Criar conta' }).click();
  await expect(page.getByText('Confirme seu e-mail')).toBeVisible();
  const mail = await latestEmail(email, 'Confirme seu e-mail');
  await page.goto(linkIn(mail.text, 'verify-email'));
  await expect(page.getByTestId('me')).toHaveText(name);
  return email;
}
