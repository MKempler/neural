-- The process group of a running command, so a run that outlives a hub restart (a code reload) is picked up
-- again and its result recorded, instead of being written off as interrupted.
ALTER TABLE job_runs ADD COLUMN pid INTEGER;
