/**
 * Persist pi-fff defaults so we do not rely on remembering CLI flags.
 * Must evaluate before @ff-labs/pi-fff so these env values are visible at its init.
 *
 * PI_FFF_MODE=override — replace built-in find/grep (no duplicate tool schema)
 * FFF_ENABLE_HOME_SCAN=0 — do not index $HOME
 */
process.env.PI_FFF_MODE ??= "override";
process.env.FFF_ENABLE_HOME_SCAN ??= "0";

export default function fffDefaults() {
	// env-only; nothing to register
}
