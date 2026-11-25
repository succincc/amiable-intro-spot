-- ============================================================================
-- Keep the score thresholds on the same scale as the scores.
--
-- Scores are 1-10 integers. Both scorers clamp to that range: the model is
-- asked for "score (1-10 integer)" and the free local keyword scorer ends
-- with max(1, min(10, ...)).
--
-- The thresholds are plain ints with no bound, so they could be set to 58 and
-- 45 — above anything a job can score. route_scored_job then sends every
-- scored job to 'skipped' with "score below review threshold", and the queue
-- never fills again. Nothing errors; applications simply stop, which is the
-- worst way for this to fail.
--
-- So: anything out of range is reset, and the range is enforced from now on.
-- ============================================================================

-- Reset before constraining, or this migration fails on exactly the database
-- that needs it. Out-of-range values carry no usable intent — a 58 on a
-- 1-10 scale is not "very strict", it is a mistake — so they go back to
-- defaults that favour volume: queue at 5 and above, review 3 and 4, skip
-- below 3.
update search_config
   set auto_apply_score = 5
 where auto_apply_score is null or auto_apply_score < 1 or auto_apply_score > 10;

update search_config
   set review_score = 3
 where review_score is null or review_score < 1 or review_score > 10;

-- review_score above auto_apply_score makes the review band empty and is
-- almost always a slip.
update search_config
   set review_score = greatest(1, auto_apply_score - 2)
 where review_score > auto_apply_score;

alter table search_config drop constraint if exists search_config_auto_apply_score_range;
alter table search_config add constraint search_config_auto_apply_score_range
  check (auto_apply_score between 1 and 10);

alter table search_config drop constraint if exists search_config_review_score_range;
alter table search_config add constraint search_config_review_score_range
  check (review_score between 1 and 10);

alter table search_config alter column auto_apply_score set default 5;
alter table search_config alter column review_score set default 3;

-- ---------------------------------------------------------------------------
-- Put back the jobs the broken thresholds threw away
-- ---------------------------------------------------------------------------
-- Everything scored while the thresholds were out of range was routed to
-- 'skipped'. Their scores are still stored, so they can be re-routed from
-- what is already there — far better than re-scoring, which would spend a
-- day's free quota to recompute numbers the database already holds.
--
-- Only jobs skipped for this specific reason are touched. A job skipped for
-- distance, or passed over by hand in review, keeps that decision.
update jobs j
   set status = case
                  when j.score >= cfg.auto_apply_score then 'queued'
                  when j.score >= cfg.review_score     then 'review'
                  else 'skipped'
                end,
       skip_reason = case
                       when j.score >= cfg.review_score then null
                       else j.skip_reason
                     end
  from search_config cfg
 where cfg.id = 1
   and j.status = 'skipped'
   and j.skip_reason = 'score below review threshold'
   and j.score is not null;
