import { getCategories, getIssues } from "./apiInteract";

export default function Home() {
  const categories = getCategories();
  const issues = getIssues();

  return (
    <main className="flex min-h-screen items-center justify-center bg-zinc-100 px-6 py-8">
      <div className="flex w-full max-w-3xl flex-col items-center text-center">
        <label htmlFor="RepoURL" className="mb-2 block text-4xl font-semibold text-zinc-700">
          Repository
        </label>
        <input
          id="RepoURL"
          type="text"
          defaultValue="https://github.com/pytorch/pytorch"
          placeholder="Enter repo URL..."
          className="w-full max-w-md rounded-full border border-zinc-300 bg-white px-5
              py-3 text-lg text-zinc-900 shadow-sm outline-none
              transition focus:border-zinc-500 focus:ring-2 focus:ring-zinc-300"
        />
        <p className="mt-6 mb-2 text-4xl font-semibold text-zinc-700">Category</p>
        <div className="mt-6 h-64 w-full max-w-md overflow-y-auto pr-1 text-left">
          {categories.map((category) => (
            <button
              key={category}
              type="button"
              className="mb-3 block w-full rounded-full border border-zinc-300 bg-white px-4 py-2 text-left
                  text-sm font-medium text-zinc-800 transition hover:bg-zinc-200"
            >
              {category}
            </button>
          ))}
        </div>
        <p className="mt-6 mb-2 text-4xl font-semibold text-zinc-700">Issues</p>
        <div className="mt-6 h-64 w-full max-w-md overflow-y-auto pr-1 text-left">
          {issues.map((issues) => (
            <button
              key={issues}
              type="button"
              className="mb-3 block w-full rounded-full border border-zinc-300 bg-white px-4 py-2 text-left
                  text-sm font-medium text-zinc-800 transition hover:bg-zinc-200"
            >
              {issues}
            </button>
          ))}
        </div>
      </div>
    </main>
  );
}
