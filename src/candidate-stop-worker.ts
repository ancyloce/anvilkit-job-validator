// The stop helper (P09 R2 expressed for the validator's steps): started by
// the trusted process under the step identity through setpriv, it kills the
// step's process group and then every live process of the step it can
// signal — group and session members and descendants of the trusted
// process — round after round until none is left, and prints a report the
// trusted process reads only as a log: the trusted process confirms the
// stop from its own read of /proc.
//
//   node candidate-stop-worker --root <trusted pid> --leader <step leader pid>
//
// Exit 0 with {"signaled": n} on stdout, 2 for a usage error, 3 when a
// process of the step refused the signal for a reason other than its
// identity, 4 when processes remain after the bounded rounds.
import { killStepProcesses } from "./isolation.js";

function main(): number {
	const args = process.argv.slice(2);
	let root = 0;
	let leader = 0;
	for (let i = 0; i + 1 < args.length; i += 2) {
		const value = Number(args[i + 1]);
		if (!Number.isInteger(value) || value <= 0) {
			console.error(`candidate-stop: ${args[i]} needs a pid`);
			return 2;
		}
		if (args[i] === "--root") root = value;
		else if (args[i] === "--leader") leader = value;
		else {
			console.error(`candidate-stop: unexpected argument ${args[i]}`);
			return 2;
		}
	}
	if (!root || !leader) {
		console.error("candidate-stop: --root and --leader are required");
		return 2;
	}
	try {
		const { signaled } = killStepProcesses({ root, leader }, process.pid);
		console.log(JSON.stringify({ signaled }));
		return 0;
	} catch (err) {
		const message = (err as Error).message;
		console.error(`candidate-stop: ${message}`);
		return message.includes("still alive") ? 4 : 3;
	}
}

process.exit(main());
