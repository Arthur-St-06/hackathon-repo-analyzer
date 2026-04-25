// DEBUG: temporary to simulate the time of an AI
function delay() {
    return new Promise((resolve) => setTimeout(resolve, 2000));
}

// Tailor the AI agent's selections
export async function sendInstructions(prompt) {
    // Placeholder for an API call
    console.log("tailoring output: " + prompt);
}

// Return the issue categories, given the URL
export async function getCategories(url) {
    // Placeholder for an API call
    let categories = ["category 1", "category 2", "category 3", "category 4", "category 5",
        "category 6", "category 7", "category 8", "category 9", "category 10", "category 11",
        "category 12", "category 13", "category 14", "category 15"];
    await delay();
    return categories;
}

// Return the issues given the category
export async function getIssues(category) {
    // Placeholder for an API call
    let issues = [
        { name: "Navbar button overlap on mobile", modules: ["ui", "api"], timeOpen: "2 days", fixAttemptStatus: "not started" },
        { name: "Login redirect fails after auth", modules: ["auth"], timeOpen: "5 days", fixAttemptStatus: "in progress" },
        { name: "Parser crashes on empty config", modules: ["parser", "ui"], timeOpen: "1 week", fixAttemptStatus: "blocked" },
        { name: "Database migration timeout on startup", modules: ["database"], timeOpen: "3 days", fixAttemptStatus: "not started" },
        { name: "Network retry loop never exits", modules: ["network", "api"], timeOpen: "4 hours", fixAttemptStatus: "in review" },
        { name: "Sidebar layout breaks on resize", modules: ["ui"], timeOpen: "12 days", fixAttemptStatus: "not started" },
        { name: "CI build fails on lint step", modules: ["build", "ci"], timeOpen: "8 days", fixAttemptStatus: "in progress" },
        { name: "Docs link to deprecated endpoint", modules: ["docs"], timeOpen: "6 hours", fixAttemptStatus: "not started" },
        { name: "API response caching corrupts records", modules: ["api", "database"], timeOpen: "9 days", fixAttemptStatus: "needs retry" },
        { name: "Test suite hangs after fixture setup", modules: ["testing"], timeOpen: "2 weeks", fixAttemptStatus: "not started" },
        { name: "Performance regression in search results", modules: ["performance", "ui"], timeOpen: "11 days", fixAttemptStatus: "in progress" },
        { name: "Security warning on token refresh", modules: ["security"], timeOpen: "7 hours", fixAttemptStatus: "not started" },
        { name: "Deploy script fails on missing env vars", modules: ["deploy", "ci"], timeOpen: "3 weeks", fixAttemptStatus: "stuck" },
        { name: "Integration test mismatch in data sync", modules: ["integration"], timeOpen: "15 days", fixAttemptStatus: "in review" },
        { name: "CLI command parser rejects valid flags", modules: ["cli", "api"], timeOpen: "18 hours", fixAttemptStatus: "not started" },
    ];

    await delay();
    return issues;
}

// Given an issue, return a summary of that issue
export async function getSummary(issue) {
    // Placeholder for an API call
    let issueSummary = "";
    for (var i = 0; i < 100; i++) {
        issueSummary += "blah ";
    }
    await delay();
    return issueSummary;
}
