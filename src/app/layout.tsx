import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: { default: "InquiryDesk", template: "%s · InquiryDesk" },
  description: "Sales inquiry and quotation assistant",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full">{children}</body>
    </html>
  );
}
