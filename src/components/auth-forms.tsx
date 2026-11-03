"use client";
import Link from "next/link";
import { useActionState } from "react";
import { loginAction, signupAction, createCompanyAction, forgotPasswordAction, resetPasswordAction, type FormState } from "@/app/actions/auth";
import { Alert, Button, Field, Input } from "./ui";

export function LoginForm() {
  const [state, action, pending] = useActionState<FormState, FormData>(loginAction, undefined);
  return (
    <form action={action} className="space-y-4">
      <h1 className="text-lg font-semibold">Sign in</h1>
      {state?.error && <Alert tone="error">{state.error}</Alert>}
      <Field label="Email" htmlFor="email"><Input id="email" name="email" type="email" autoComplete="email" required /></Field>
      <Field label="Password" htmlFor="password"><Input id="password" name="password" type="password" autoComplete="current-password" required /></Field>
      <div className="-mt-2 text-end text-sm"><Link className="text-brand-700 underline" href="/forgot-password">Forgot your password?</Link></div>
      <Button type="submit" disabled={pending} className="w-full">{pending ? "Signing in…" : "Sign in"}</Button>
      <p className="text-center text-sm text-muted">New here? <Link className="font-medium text-brand-700 underline" href="/signup">Create an account</Link></p>
    </form>
  );
}

export function SignupForm() {
  const [state, action, pending] = useActionState<FormState, FormData>(signupAction, undefined);
  return (
    <form action={action} className="space-y-4">
      <h1 className="text-lg font-semibold">Create your account</h1>
      {state?.error && <Alert tone="error">{state.error}</Alert>}
      {state?.message && <Alert tone="success">{state.message}</Alert>}
      <Field label="Your name" htmlFor="fullName"><Input id="fullName" name="fullName" autoComplete="name" required /></Field>
      <Field label="Work email" htmlFor="email"><Input id="email" name="email" type="email" autoComplete="email" required /></Field>
      <Field label="Password" htmlFor="password" hint="At least 10 characters.">
        <Input id="password" name="password" type="password" autoComplete="new-password" minLength={10} required />
      </Field>
      <Button type="submit" disabled={pending} className="w-full">{pending ? "Creating account…" : "Create account"}</Button>
      <p className="text-center text-sm text-muted">Already registered? <Link className="font-medium text-brand-700 underline" href="/login">Sign in</Link></p>
    </form>
  );
}

export function CompanyForm() {
  const [state, action, pending] = useActionState<FormState, FormData>(createCompanyAction, undefined);
  return (
    <form action={action} className="space-y-4">
      {state?.error && <Alert tone="error">{state.error}</Alert>}
      <Field label="Company name" htmlFor="name" hint="You'll be the workspace admin. You can add colleagues later.">
        <Input id="name" name="name" required minLength={2} />
      </Field>
      <Field label="Your name (shown on quotations)" htmlFor="fullName" hint="Leave blank to use the name you signed up with."><Input id="fullName" name="fullName" /></Field>
      <Button type="submit" disabled={pending} className="w-full">{pending ? "Creating…" : "Create company workspace"}</Button>
    </form>
  );
}

export function ForgotPasswordForm() {
  const [state, action, pending] = useActionState<FormState, FormData>(forgotPasswordAction, undefined);
  return (
    <form action={action} className="space-y-4">
      <h1 className="text-lg font-semibold">Reset your password</h1>
      <p className="text-sm text-muted">Enter the email you signed up with and we&apos;ll send you a link to choose a new password.</p>
      {state?.error && <Alert tone="error">{state.error}</Alert>}
      {state?.message ? <Alert tone="success">{state.message}</Alert> : (
        <>
          <Field label="Email" htmlFor="email"><Input id="email" name="email" type="email" autoComplete="email" required /></Field>
          <Button type="submit" disabled={pending} className="w-full">{pending ? "Sending…" : "Send reset link"}</Button>
        </>
      )}
      <p className="text-center text-sm text-muted"><Link className="font-medium text-brand-700 underline" href="/login">Back to sign in</Link></p>
    </form>
  );
}

export function ResetPasswordForm({ email }: { email: string }) {
  const [state, action, pending] = useActionState<FormState, FormData>(resetPasswordAction, undefined);
  return (
    <form action={action} className="space-y-4">
      <h1 className="text-lg font-semibold">Choose a new password</h1>
      <p className="text-sm text-muted">For {email}</p>
      {state?.error && <Alert tone="error">{state.error}</Alert>}
      <Field label="New password" htmlFor="password" hint="At least 10 characters.">
        <Input id="password" name="password" type="password" autoComplete="new-password" minLength={10} required />
      </Field>
      <Field label="Repeat new password" htmlFor="confirm">
        <Input id="confirm" name="confirm" type="password" autoComplete="new-password" minLength={10} required />
      </Field>
      <Button type="submit" disabled={pending} className="w-full">{pending ? "Saving…" : "Save new password"}</Button>
    </form>
  );
}
