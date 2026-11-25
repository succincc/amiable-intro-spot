CREATE TABLE public.board_credentials (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  board text NOT NULL,
  label text,
  username text NOT NULL,
  password_ciphertext text,
  password_iv text,
  notes text,
  enabled boolean NOT NULL DEFAULT true,
  last_login_at timestamptz,
  last_login_status text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

GRANT SELECT, INSERT, UPDATE, DELETE ON public.board_credentials TO authenticated;
GRANT ALL ON public.board_credentials TO service_role;

ALTER TABLE public.board_credentials ENABLE ROW LEVEL SECURITY;

CREATE POLICY "owner manages board credentials"
ON public.board_credentials FOR ALL TO authenticated
USING (true) WITH CHECK (true);

CREATE TRIGGER board_credentials_touch
BEFORE UPDATE ON public.board_credentials
FOR EACH ROW EXECUTE FUNCTION public.touch_updated_at();

ALTER TABLE public.search_presets
  ADD COLUMN IF NOT EXISTS ai_answers_enabled boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS answer_tone text NOT NULL DEFAULT 'confident',
  ADD COLUMN IF NOT EXISTS answer_max_words integer NOT NULL DEFAULT 120,
  ADD COLUMN IF NOT EXISTS answer_review_required boolean NOT NULL DEFAULT false;