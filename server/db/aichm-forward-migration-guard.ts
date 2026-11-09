const SCRATCH_DATABASE_PREFIX = "aichm_forward_scratch_";

export function requireAichmForwardScratchDatabaseUrl(
  urlValue = process.env.AICHM_FORWARD_DATABASE_URL,
  target = process.env.AICHM_FORWARD_TARGET,
): string {
  if (target !== "scratch") {
    throw new Error("AICHM_FORWARD_SCRATCH_TARGET_REQUIRED");
  }
  if (!urlValue || urlValue.trim() !== urlValue) {
    throw new Error("AICHM_FORWARD_SCRATCH_DATABASE_URL_REQUIRED");
  }

  let url: URL;
  try {
    url = new URL(urlValue);
  } catch {
    throw new Error("AICHM_FORWARD_SCRATCH_DATABASE_URL_INVALID");
  }

  let database: string;
  try {
    database = decodeURIComponent(url.pathname.replace(/^\/+/, ""));
  } catch {
    throw new Error("AICHM_FORWARD_SCRATCH_DATABASE_URL_INVALID");
  }

  let queryCount = 0;
  let queryKey = "";
  let queryValue = "";
  url.searchParams.forEach((value, key) => {
    queryCount += 1;
    queryKey = key;
    queryValue = value;
  });
  const queryIsAllowed =
    queryCount === 0 ||
    (queryCount === 1 && queryKey === "sslmode" && queryValue === "disable");

  if (
    url.protocol !== "postgresql:" ||
    url.hostname !== "127.0.0.1" ||
    !/^([1-9]\d{0,4})$/.test(url.port) ||
    Number(url.port) > 65535 ||
    url.username !== "postgres" ||
    url.password !== "" ||
    !new RegExp(`^${SCRATCH_DATABASE_PREFIX}[a-z0-9_]+$`).test(database) ||
    !queryIsAllowed ||
    url.hash !== ""
  ) {
    throw new Error("AICHM_FORWARD_SCRATCH_TARGET_REJECTED");
  }

  return urlValue;
}
