import type { Metadata } from "next";

export function pageMetadata(title: string, description: string): Metadata {
  const fullTitle = `${title} — Fleet`;
  return {
    title: fullTitle,
    description,
    openGraph: { title: fullTitle, description, type: "website", images: [] },
    twitter: { card: "summary", title: fullTitle, description, images: [] },
  };
}
