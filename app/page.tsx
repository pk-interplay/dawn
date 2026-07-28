import Link from "next/link";
import { Button } from "@/components/ui/button";

export default function Home() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-6 px-6 text-center">
      <h1 className="text-5xl font-semibold tracking-tight sm:text-6xl">Dawn</h1>
      <p className="text-muted-foreground max-w-md text-lg text-balance">
        The agent that knows where you&apos;re going.
      </p>
      <Button asChild size="xl" className="mt-2 rounded-full">
        <Link href="/join">Join</Link>
      </Button>
      <p className="text-muted-foreground text-sm">
        Already a member?{" "}
        <Link href="/login" className="text-foreground underline underline-offset-4">
          Sign in
        </Link>
      </p>
    </main>
  );
}
