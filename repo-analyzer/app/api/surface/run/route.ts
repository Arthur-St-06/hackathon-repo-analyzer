import { POST as dryRunPOST } from "../dry-run/route";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
	return dryRunPOST(request);
}
