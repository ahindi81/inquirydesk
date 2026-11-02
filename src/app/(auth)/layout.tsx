export default function AuthLayout({ children }: LayoutProps<"/">) {
  return (
    <main className="flex min-h-screen items-center justify-center bg-navy-900 px-4 py-10">
      <div className="w-full max-w-md">
        <div className="mb-6 text-center">
          <p className="text-2xl font-semibold text-white">Inquiry<span className="text-brand-500">Desk</span></p>
          <p className="mt-1 text-sm text-navy-200">Sales inquiries to quotations, with evidence for every line.</p>
        </div>
        <div className="rounded-lg bg-white p-6 shadow-xl">{children}</div>
      </div>
    </main>
  );
}
