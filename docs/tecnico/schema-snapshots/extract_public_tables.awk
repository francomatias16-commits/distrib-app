/^CREATE TABLE public\./ { 
  table_name = substr($3, 1, length($3)-1); 
  start_capture = 1; 
  print; 
  next; 
} 
start_capture == 1 { 
  print; 
  if (/^);/) { 
    start_capture = 0; 
  } 
} 
