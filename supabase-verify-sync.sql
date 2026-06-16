select
  c.relname as table_name,
  c.relrowsecurity as rls_enabled,
  array_agg(distinct p.polname order by p.polname) filter (where p.polname is not null) as policies
from pg_class c
join pg_namespace n on n.oid = c.relnamespace
left join pg_policy p on p.polrelid = c.oid
where n.nspname = 'public'
  and c.relname in ('profiles', 'meal_logs')
group by c.relname, c.relrowsecurity
order by c.relname;
