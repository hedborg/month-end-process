-- Month-end process schema

CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  name TEXT NOT NULL,
  email TEXT,
  active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE cycles (
  id SERIAL PRIMARY KEY,
  label TEXT NOT NULL UNIQUE, -- e.g. '2026-06'
  year INT NOT NULL,
  month INT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'locked', 'archived')),
  notes TEXT,
  created_from_cycle_id INT REFERENCES cycles(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE tasks (
  id SERIAL PRIMARY KEY,
  cycle_id INT NOT NULL REFERENCES cycles(id) ON DELETE CASCADE,
  sort_order INT NOT NULL DEFAULT 0,
  task_name TEXT NOT NULL,
  description TEXT,
  dependency_text TEXT,
  due_date TEXT, -- free text: '1', '3', '15.1', '25th Prev Month', 'N/A'
  booking_responsible_id INT REFERENCES users(id),
  quality_check_id INT REFERENCES users(id),
  url TEXT,
  powerbi_url TEXT,
  booking_status TEXT NOT NULL DEFAULT 'not_started'
    CHECK (booking_status IN ('not_started', 'in_progress', 'waiting', 'done', 'n_a')),
  check_status TEXT NOT NULL DEFAULT 'not_started'
    CHECK (check_status IN ('not_started', 'in_progress', 'waiting', 'done', 'n_a')),
  date_finished DATE,
  comment TEXT,
  mg_comment TEXT,
  cloned_from_task_id INT REFERENCES tasks(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX idx_tasks_cycle_id ON tasks(cycle_id);
