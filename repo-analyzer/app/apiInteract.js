// DEBUG: temporary to simulate the time of an AI
function delay() {
    return new Promise((resolve) => setTimeout(resolve, 2000));
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
    let issues = ["issue 1", "issue 2", "issue 3", "issue 4", "issue 5", "issue 6",
        "issue 7", "issue 8", "issue 9", "issue 10", "issue 11", "issue 12", "issue 13",
        "issue 14", "issue 15"];
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