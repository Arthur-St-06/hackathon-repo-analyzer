export default function Home() {
  return (
    <main className="flex min-h-screen items-start justify-center bg-zinc-100 px-6 pt-8">
      <input
        id="RepoURL"
        type="text"
        defaultValue="https://github.com/pytorch/pytorch"
        placeholder="Repo URL here..."
        className="w-full max-w-md rounded-full border border-zinc-300 bg-white px-5 py-3 text-lg text-zinc-900 shadow-sm outline-none transition focus:border-zinc-500 focus:ring-2 focus:ring-zinc-300"
      />
    </main >
  );
}
