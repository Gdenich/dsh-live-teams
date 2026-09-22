import { execFile } from "node:child_process";
//#region src/changed-paths.ts
/**
* What changed in a workspace, for the declared-scope check (B30).
*
* The store never shells out itself: it takes a port, and the plugin supplies this
* adapter. `undefined` means "not observable" — no git, not a repository, an
* unparsable answer, or more changes than the cap — and is recorded as `unchecked`
* rather than as a clean result.
*
* `--porcelain -z` is used because the output is byte-exact: entries are NUL separated,
* a rename prints the *new* path first and the original as the next record, and no
* quoting or escaping is applied to unusual file names.
*/
const CHANGED_PATHS_LIMIT = 2e3;
function parsePorcelainZ(stdout) {
	const records = stdout.split("\0");
	const changed = [];
	for (let index = 0; index < records.length; index += 1) {
		const record = records[index];
		if (record.length === 0) continue;
		if (record.length < 4 || record[2] !== " ") return void 0;
		const status = record.slice(0, 2);
		const target = record.slice(3);
		if (target.length === 0) return void 0;
		changed.push(target);
		if (status[0] === "R" || status[0] === "C") index += 1;
		if (changed.length > 2e3) return void 0;
	}
	return changed;
}
async function gitChangedPaths(workspacePath) {
	return await new Promise((resolve) => {
		execFile("git", [
			"-C",
			workspacePath,
			"status",
			"--porcelain",
			"-z"
		], {
			timeout: 5e3,
			maxBuffer: 4194304
		}, (error, stdout) => {
			if (error) {
				resolve(void 0);
				return;
			}
			resolve(parsePorcelainZ(stdout));
		});
	});
}
async function workspaceMode(workspacePath) {
	return await new Promise((resolve) => {
		execFile("git", [
			"-C",
			workspacePath,
			"rev-parse",
			"--is-inside-work-tree"
		], { timeout: 5e3 }, (error, stdout) => {
			if (error) {
				resolve("files");
				return;
			}
			resolve(stdout.trim() === "true" ? "git" : "files");
		});
	});
}
//#endregion
export { CHANGED_PATHS_LIMIT, gitChangedPaths, parsePorcelainZ, workspaceMode };
