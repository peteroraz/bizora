export function confirmPasswordError(password: string, confirmation: string): string | null {
  if (password === confirmation) return null;
  return "Passwords do not match.";
}
