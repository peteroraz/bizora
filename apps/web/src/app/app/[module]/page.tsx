import { Badge, EmptyState } from "@bizora/ui";
import { notFound } from "next/navigation";
import { comingSoonModules } from "../../../lib/nav";

export default async function ComingSoonPage({ params }: { params: Promise<{ module: string }> }) {
  const { module } = await params;
  const title = comingSoonModules[module as keyof typeof comingSoonModules];
  if (!title) notFound();
  return (
    <EmptyState
      title={`${title} is coming soon`}
      description="This part of Bizora is on the roadmap. Your workspace, team, and settings are ready to use today."
      action={<Badge tone="info">Soon</Badge>}
    />
  );
}
