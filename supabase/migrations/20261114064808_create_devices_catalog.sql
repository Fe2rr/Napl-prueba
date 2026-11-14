CREATE TABLE public.devices (
    id text PRIMARY KEY CHECK (length(id) BETWEEN 1 AND 200),
    name text NOT NULL CHECK (length(name) BETWEEN 1 AND 240)
);
ALTER TABLE public.devices ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE public.devices FROM PUBLIC, anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE public.devices TO service_role;

ALTER TABLE public.compatibility_reports
    ADD CONSTRAINT compatibility_reports_device_id_fkey
    FOREIGN KEY (device_id) REFERENCES public.devices(id)
    ON UPDATE CASCADE ON DELETE RESTRICT;

CREATE OR REPLACE FUNCTION public.get_compatibility_devices()
RETURNS jsonb
LANGUAGE sql
STABLE
SECURITY INVOKER
SET search_path = public, pg_temp
AS $function$
    SELECT COALESCE(
        jsonb_agg(jsonb_build_object('id', id, 'name', name) ORDER BY name COLLATE "C"),
        '[]'::jsonb
    )
    FROM public.devices;
$function$;

DROP FUNCTION public.upsert_compatibility_report(text, text, text, text, boolean);

CREATE FUNCTION public.upsert_compatibility_report(
    p_port_id text,
    p_token_hash text,
    p_device_id text,
    p_works boolean
)
RETURNS jsonb
LANGUAGE plpgsql
SECURITY INVOKER
SET search_path = public, pg_temp
AS $function$
DECLARE
    saved public.compatibility_reports%ROWTYPE;
    selected_device_name text;
BEGIN
    SELECT name INTO selected_device_name FROM public.devices WHERE id = p_device_id;
    IF selected_device_name IS NULL THEN
        RAISE EXCEPTION 'Invalid device ID';
    END IF;

    INSERT INTO public.compatibility_reports
        (port_id, token_hash, device_id, device_name, works, updated_at)
    VALUES
        (p_port_id, p_token_hash, p_device_id, selected_device_name, p_works, now())
    ON CONFLICT (port_id, token_hash, device_id)
    DO UPDATE SET
        device_name = EXCLUDED.device_name,
        works = EXCLUDED.works,
        updated_at = now()
    RETURNING * INTO saved;

    RETURN jsonb_build_object(
        'report', jsonb_build_object(
            'portId', saved.port_id, 'deviceId', saved.device_id,
            'deviceName', saved.device_name, 'works', saved.works,
            'updatedAt', saved.updated_at
        ),
        'summary', public.get_compatibility_for_ports(ARRAY[p_port_id]) -> p_port_id
    );
END;
$function$;

REVOKE ALL ON FUNCTION public.get_compatibility_devices() FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.get_compatibility_devices() TO service_role;
REVOKE ALL ON FUNCTION public.upsert_compatibility_report(text, text, text, boolean) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.upsert_compatibility_report(text, text, text, boolean) TO service_role;

-- Index the referencing side of the device foreign key for efficient checks.
CREATE INDEX compatibility_reports_device_id_idx
    ON public.compatibility_reports (device_id);
