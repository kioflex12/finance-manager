-- оформление комнаты: эмодзи-аватар и цвет из фиксированного набора
ALTER TABLE rooms ADD COLUMN emoji text;
ALTER TABLE rooms ADD COLUMN color text NOT NULL DEFAULT 'violet';

-- позиция: каноническое название того, на что потрачено («кофеёчек» → «кофе»),
-- по ней траты внутри категории складываются в одну строку
ALTER TABLE operations ADD COLUMN item text;
UPDATE operations SET item = lower(description);
ALTER TABLE operations ALTER COLUMN item SET NOT NULL;
CREATE INDEX operations_room_item_idx ON operations (room_id, item);

ALTER TABLE rules ADD COLUMN item text;
