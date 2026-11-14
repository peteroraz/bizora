import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { designPreviewAllowed } from "@/design/preview-access";
import { DesignPreview } from "./preview";

export const metadata: Metadata = {
  title: "Design preview",
  robots: { index: false, follow: false },
};

export default function DesignPreviewPage() {
  if (!designPreviewAllowed(process.env.NODE_ENV)) {
    notFound();
  }

  return <DesignPreview />;
}
