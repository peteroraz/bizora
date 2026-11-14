import { forwardRef } from "react";
import type { ButtonProps } from "./button";
import { Button } from "./button";

export const IconButton = forwardRef<HTMLButtonElement, ButtonProps & { label: string }>(function IconButton(
  { label, ...props },
  ref,
) {
  return <Button ref={ref} size="icon" aria-label={label} {...props} />;
});
