"use client";

import { useEffect, useState } from "react";
import { getCategories, getIssues, getSummary } from "./apiInteract";

type Issue = {
  name: string;
  modules: string[];
  timeOpen: string;
  fixAttemptStatus: string;
};

export default function Home() {
  let repoUrl = "https://github.com/pytorch/pytorch";
  const [categories, setCategories] = useState<string[]>([]);
  const [loadingCategories, setLoadingCategories] = useState(true);
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null);
  const [issues, setIssues] = useState<Issue[]>([]);
  const [loadingIssues, setLoadingIssues] = useState(false);
  const [selectedIssue, setSelectedIssue] = useState<string | null>(null);
  const [summary, setSummary] = useState<string | null>(null);
  const [loadingSummary, setLoadingSummary] = useState(false);

  useEffect(() => {
    let mounted = true;

    async function loadCategoriesData() {
      setLoadingCategories(true);
      const loadedCategories = await getCategories();
      if (mounted) {
        setCategories(loadedCategories);
        setLoadingCategories(false);
      }
    }

    loadCategoriesData();

    return () => {
      mounted = false;
    };
  }, []);

  useEffect(() => {
    let mounted = true;

    async function loadIssuesData() {
      if (!selectedCategory) {
        setIssues([]);
        setSelectedIssue(null);
        setSummary(null);
        setLoadingIssues(false);
        return;
      }

      setLoadingIssues(true);
      const loadedIssues = await getIssues(selectedCategory);
      if (mounted) {
        setIssues(loadedIssues);
        setLoadingIssues(false);
      }
    }

    loadIssuesData();

    return () => {
      mounted = false;
    };
  }, [selectedCategory]);

  useEffect(() => {
    let mounted = true;

    async function loadSummaryData() {
      if (!selectedIssue) {
        setSummary(null);
        setLoadingSummary(false);
        return;
      }

      setLoadingSummary(true);
      const loadedSummary = await getSummary(selectedIssue);
      if (mounted) {
        setSummary(loadedSummary);
        setLoadingSummary(false);
      }
    }

    loadSummaryData();

    return () => {
      mounted = false;
    };
  }, [selectedIssue]);

  return (
    <main className="flex min-h-screen items-top justify-center bg-zinc-100 px-6 py-8">
      <div className="flex w-full max-w-3xl flex-col items-center text-center">
        <label htmlFor="RepoURL" className="mb-6 block text-6xl font-semibold text-zinc-700">
          Repository
        </label>
        <input
          id="RepoURL"
          type="text"
          defaultValue="https://github.com/pytorch/pytorch"
          readOnly
          placeholder="Enter repo URL..."
          className="w-full max-w-xl rounded-full border border-zinc-300 bg-white px-7
        py-4 text-2xl text-zinc-900 shadow-sm outline-none
        transition focus:border-zinc-500 focus:ring-2 focus:ring-zinc-300"
        />
        <p className="mt-16 mb-0 text-6xl font-semibold text-zinc-700">Category</p>
        {selectedCategory ? (
          <div className="mt-6 flex w-full max-w-2xl items-center justify-center gap-4">
            <div className="rounded-full border border-zinc-300 bg-white px-8 py-4 text-xl font-medium text-zinc-800">
              {"Selected: " + selectedCategory}
            </div>
            <button
              type="button"
              onClick={() => setSelectedCategory(null)}
              className="rounded-full border border-zinc-300 bg-white px-6 py-4 text-xl font-medium text-zinc-800 transition hover:bg-zinc-200"
            >
              Deselect
            </button>
          </div>
        ) : (
          <div className="mt-6 h-64 w-full max-w-2xl overflow-y-auto pr-1 text-left">
            {loadingCategories ? (
              <p className="text-xl text-zinc-500">Loading...</p>
            ) : (repoUrl != "") ? (
              categories.map((category) => (
                <button
                  key={category}
                  type="button"
                  onClick={() => setSelectedCategory(category)}
                  className="mb-3 block w-full rounded-full border border-zinc-300 bg-white px-6 py-4 text-left
                  text-xl font-medium text-zinc-800 transition hover:bg-zinc-200"
                >
                  {category}
                </button>
              ))
            ) : (
              <p className="text-xl text-zinc-500">Enter a URL to see categories.</p>
            )}
          </div>
        )}
        <p className="mt-16 mb-0 text-6xl font-semibold text-zinc-700">Issues</p>
        {selectedIssue ? (
          <div className="mt-6 flex w-full max-w-2xl items-center justify-center gap-4">
            <div className="rounded-full border border-zinc-300 bg-white px-8 py-4 text-xl font-medium text-zinc-800">
              {"Selected: " + selectedIssue}
            </div>
            <button
              type="button"
              onClick={() => setSelectedIssue(null)}
              className="rounded-full border border-zinc-300 bg-white px-6 py-4 text-xl font-medium text-zinc-800 transition hover:bg-zinc-200"
            >
              Deselect
            </button>
          </div>
        ) : (
          <div className="mt-6 h-128 w-full max-w-2xl overflow-y-auto pr-1 text-left">
            {loadingIssues ? (
              <p className="text-xl text-zinc-500">Loading...</p>
            ) : selectedCategory ? (
              issues.map((issue) => (
                <button
                  key={issue.name}
                  type="button"
                  onClick={() => setSelectedIssue(issue.name)}
                  className="mb-3 block w-full rounded-3xl border border-zinc-300 bg-white px-6 py-5 text-left
                  text-zinc-800 transition hover:bg-zinc-200"
                >
                  <div className="text-2xl font-semibold">{issue.name}</div>
                  <div className="mt-2 text-lg text-zinc-600">
                    <p>Modules: {issue.modules.join(", ")}</p>
                    <p>Time open: {issue.timeOpen}</p>
                    <p>Fix attempt status: {issue.fixAttemptStatus}</p>
                  </div>
                </button>
              ))
            ) : (
              <p className="text-xl text-zinc-500">Select a category to see issues.</p>
            )}
          </div>
        )}
        <p className="mt-16 mb-0 text-6xl font-semibold text-zinc-700">Issue Summary</p>
        <div className="mt-6 w-full max-w-2xl rounded-3xl border border-zinc-300 bg-white p-6 text-left text-xl text-zinc-800">
          {loadingSummary ? (
            <p>Loading...</p>
          ) : summary ? (
            <p>{summary}</p>
          ) : (
            <p className="text-zinc-500">Select an issue to see summary.</p>
          )}
        </div>
      </div>
    </main>
  );
}
