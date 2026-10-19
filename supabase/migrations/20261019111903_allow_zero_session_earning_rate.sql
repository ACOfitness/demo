-- Session outcomes must accept the same nonnegative historical rates as trainer rates.
-- A consultation has independent pay; its historical hourly reference may be zero.
-- Do not rewrite historical rates, earnings, or attendance.
begin;
alter table public.aco_earnings drop constraint aco_earnings_rate_grosz_check;
alter table public.aco_earnings add constraint aco_earnings_rate_grosz_check
 check (rate_grosz >= 0 and (kind <> 'company' or rate_grosz > 0));
commit;
