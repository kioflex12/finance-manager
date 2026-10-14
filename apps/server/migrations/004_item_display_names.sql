-- названия трат показываются в едином виде — с большой буквы
UPDATE operations SET item = upper(left(item, 1)) || substr(item, 2);
UPDATE rules SET item = upper(left(item, 1)) || substr(item, 2) WHERE item IS NOT NULL;
