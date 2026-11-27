// A person's own key to the writing model, where they have saved one.
//
// The runner's shared key is the fallback. A person who has pasted their own
// in Settings has their resumes and answers written on their own free
// allowance instead; the key is put where the rest of the code already
// looks for one, and is never printed.

/** Takes the script's own way of asking the database. Says only whether a key was found. */
export async function useOwnKey(db) {
  // The second key, for when the first has no allowance left: asked for on
  // its own, since the column is newer than some databases.
  try {
    const rows = await db("user_keys?select=groq_key&limit=1");
    const second = String(rows?.[0]?.groq_key ?? "").trim();
    if (/^gsk_[A-Za-z0-9]{20,120}$/.test(second)) process.env.GROQ_API_KEY = second;
  } catch {
    /* no such column yet, or nothing saved: the shared one, if any, stands */
  }
  try {
    const rows = await db("user_keys?select=gemini_key&limit=1");
    const key = String(rows?.[0]?.gemini_key ?? "").trim();
    if (/^[A-Za-z0-9_-]{20,80}$/.test(key)) {
      process.env.GEMINI_API_KEY = key;
      return true;
    }
  } catch {
    /* the table is newer than this database, or nothing is saved: the shared key stands */
  }
  return false;
}
